import fs from 'fs/promises';
import os from 'os';

import { generateText } from 'ai';
import { DefaultTaskState, getRepositoryMappingsSettings } from '@common/types';
import { compareBaseDirs, extractProviderModel, normalizeBaseDir } from '@common/utils';

import { errorText } from './generator-utils';
import { setRepositoryMappingsEventListener } from './hooks';
import { setRepositoryMappingsManager } from './instance';
import { LARAVEL_GENERATOR_ID, runLaravelGenerator } from './laravel-generator';
import { REPOSITORY_MAPPING_GENERATOR_LABELS, getMappingsDir, readRepositoryMappingsState, writeRepositoryMappingsState } from './mappings-state';
import { OUTLINE_GENERATOR_ID, runOutlineGenerator } from './outline-generator';
import { listRepositoryMappingFiles, runCustomMappingsScript } from './repository-mappings';

import type { GeneratorContext, RepositoryMappingsGenerate } from './generator-utils';
import type { Store } from '@/store';
import type { ProjectManager } from '@/project';
import type { ModelManager } from '@/models';
import type { EventManager } from '@/events';
import type { RegenerateRepositoryMappingsResult, RepositoryMappingsState } from '@common/types';

import { execWithShellPath } from '@/utils';
import logger from '@/logger';

export type { RepositoryMappingsGenerate } from './generator-utils';

/** Id of the hidden internal task (same value as `INTERNAL_TASK_ID` in `@/task/task`, which is not imported here to avoid an import cycle). */
const INTERNAL_TASK_ID = 'internal';
const DEFAULT_SCHEDULE_DELAY_MS = 5000;

export interface RepositoryMappingsManagerDependencies {
  store: Store;
  projectManager: ProjectManager;
  modelManager: ModelManager;
  eventManager: EventManager;
  /** Replaces the model call (tests). */
  generate?: RepositoryMappingsGenerate;
  /** Delay before a scheduled run; default 5000. */
  scheduleDelayMs?: number;
  /** Home directory for path rules; default os.homedir(). */
  homeDir?: string;
}

interface TaskUpdate {
  id?: string;
  baseDir?: string;
  state?: string;
}

const buildHeader = (now: string, commit: string | null): string =>
  `Generated ${now.slice(0, 16).replace('T', ' ')} UTC${commit ? ` at commit ${commit}` : ''}. Updated automatically as the project changes.`;

/** Generates the built-in repository mappings in the background: after a prompt finishes, when a project opens, and on request. */
export class RepositoryMappingsManager {
  private disposed = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly runs = new Map<string, Promise<RepositoryMappingsState>>();
  private readonly pending = new Set<string>();
  private readonly taskStates = new Map<string, string | undefined>();

  constructor(private readonly dependencies: RepositoryMappingsManagerDependencies) {}

  /** Starts listening for task updates. */
  init(): void {
    if (this.disposed) {
      return;
    }
    setRepositoryMappingsEventListener(this.handleEvent);
  }

  /** Stops listening and cancels scheduled runs. Afterwards nothing new is scheduled. */
  dispose(): void {
    this.disposed = true;
    setRepositoryMappingsEventListener(null);
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** Background regeneration, debounced per project. Never throws; does nothing when automatic updates are off. */
  scheduleRegeneration(baseDir: string, reason: 'project-open' | 'prompt-finished'): void {
    if (this.disposed || !getRepositoryMappingsSettings(this.dependencies.store.getSettings()).autoRegenerate) {
      return;
    }
    const key = normalizeBaseDir(baseDir);
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.enqueue(baseDir, false).catch((error: unknown) => {
        logger.warn('[RepositoryMappings] Background update failed', { baseDir, reason, error: errorText(error) });
      });
    }, this.dependencies.scheduleDelayMs ?? DEFAULT_SCHEDULE_DELAY_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** On request: runs every enabled generator regardless of fingerprints, then the project's own mappings.sh if it has one. */
  async regenerate(baseDir: string): Promise<RegenerateRepositoryMappingsResult> {
    const attemptStart = new Date().toISOString();
    const state = await this.enqueue(baseDir, true);
    const custom = await runCustomMappingsScript(baseDir);
    await this.notifyUpdated(baseDir);

    const errors: string[] = [];
    for (const [id, generator] of Object.entries(state.generators)) {
      if (generator.message && generator.lastFailureAt && generator.lastFailureAt >= attemptStart) {
        errors.push(`${REPOSITORY_MAPPING_GENERATOR_LABELS[id] ?? id}: ${generator.message}`);
      }
    }
    if (custom.error) {
      errors.push(`mappings.sh: ${custom.error}`);
    }
    return errors.length > 0 ? { success: false, error: errors.join('\n') } : { success: true };
  }

  /** Runs the generators once and returns the saved state. `force` ignores fingerprints and the failure back-off. */
  async runGenerators(baseDir: string, force: boolean): Promise<RepositoryMappingsState> {
    const rawSettings = this.dependencies.store.getSettings();
    const settings = getRepositoryMappingsSettings(rawSettings);
    const projectSettings = this.dependencies.store.getProjectSettings(baseDir);
    settings.outlineRules = [
      ...settings.outlineRules,
      ...getRepositoryMappingsSettings({ repositoryMappings: { outlineRules: projectSettings.outlineRules } }).outlineRules,
    ];
    await fs.mkdir(getMappingsDir(baseDir), { recursive: true });
    const state = await readRepositoryMappingsState(baseDir);
    const now = new Date().toISOString();

    const context: GeneratorContext = {
      baseDir,
      settings,
      descriptionModel: rawSettings.taskNavigation?.summaryModel || rawSettings.taskSettings?.taskNameModel || null,
      state,
      force,
      now,
      header: buildHeader(now, await this.getCommit(baseDir)),
      homeDir: this.dependencies.homeDir ?? os.homedir(),
      generate: this.dependencies.generate ?? this.generateWithModel,
    };

    await this.runSafely(context, OUTLINE_GENERATOR_ID, runOutlineGenerator);
    await this.runSafely(context, LARAVEL_GENERATOR_ID, runLaravelGenerator);

    await writeRepositoryMappingsState(baseDir, state);
    await this.notifyUpdated(baseDir);
    return state;
  }

  /** At most one run per project. A background request during a run queues one more run; a forced one waits, then runs forced. */
  private enqueue(baseDir: string, force: boolean): Promise<RepositoryMappingsState> {
    const key = normalizeBaseDir(baseDir);
    const active = this.runs.get(key);
    if (active) {
      if (!force) {
        this.pending.add(key);
        return active;
      }
      return active.catch(() => undefined).then(() => this.enqueue(baseDir, true));
    }

    const run = this.runGenerators(baseDir, force);
    this.runs.set(key, run);
    void run
      .catch(() => undefined)
      .then(() => {
        this.runs.delete(key);
        if (this.pending.delete(key) && !this.disposed) {
          this.enqueue(baseDir, false).catch((error: unknown) => {
            logger.warn('[RepositoryMappings] Queued update failed', { baseDir, error: errorText(error) });
          });
        }
      });
    return run;
  }

  private async runSafely(context: GeneratorContext, id: string, generator: (context: GeneratorContext) => Promise<void>): Promise<void> {
    try {
      await generator(context);
    } catch (error) {
      const previous = context.state.generators[id];
      context.state.generators[id] = {
        ...(previous ?? { files: {} }),
        message: errorText(error),
        attemptedAt: context.now,
        lastFailureAt: context.now,
      };
      logger.warn('[RepositoryMappings] Generator failed', { baseDir: context.baseDir, generator: id, error: errorText(error) });
    }
  }

  private async getCommit(baseDir: string): Promise<string | null> {
    try {
      const { stdout } = await execWithShellPath(['git', 'rev-parse', '--short', 'HEAD'], { cwd: baseDir });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async notifyUpdated(baseDir: string): Promise<void> {
    try {
      const files = await listRepositoryMappingFiles(baseDir);
      this.dependencies.eventManager.sendRepositoryMappingsUpdated(baseDir, files);
      const project = this.dependencies.projectManager.getProjects().find((candidate) => compareBaseDirs(candidate.baseDir, baseDir));
      project?.forEachTask((task) => {
        void task.sendContextManifestUpdated();
        void task.updateAgentEstimatedTokens();
      });
    } catch (error) {
      logger.warn('[RepositoryMappings] Failed to send the mappings update', { baseDir, error: errorText(error) });
    }
  }

  private readonly handleEvent = (eventType: string, data: unknown): void => {
    if (this.disposed || eventType !== 'task-updated' || !data || typeof data !== 'object') {
      return;
    }
    const task = data as TaskUpdate;
    if (!task.id || !task.baseDir || task.id === INTERNAL_TASK_ID) {
      return;
    }
    const key = `${task.baseDir}\n${task.id}`;
    const previousState = this.taskStates.get(key);
    this.taskStates.set(key, task.state);
    if (previousState === DefaultTaskState.InProgress && task.state !== DefaultTaskState.InProgress) {
      this.scheduleRegeneration(task.baseDir, 'prompt-finished');
    }
  };

  private readonly generateWithModel: RepositoryMappingsGenerate = async (modelId, baseDir, systemPrompt, prompt, timeoutMs) => {
    const { modelManager, store } = this.dependencies;
    const [providerId, modelName] = extractProviderModel(modelId);
    const provider = modelManager.getProviders().find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }
    const model = await modelManager.createLlm(provider, modelName, store.getSettings(), baseDir, undefined, systemPrompt);
    const result = await generateText({
      model,
      instructions: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      abortSignal: AbortSignal.timeout(timeoutMs),
      providerOptions: modelManager.getProviderOptions(provider, modelName),
      ...modelManager.getProviderParameters(provider, modelName),
    });
    return result.text;
  };
}

/** Creates the manager, registers it as the app-wide instance and starts it. */
export const initRepositoryMappings = (dependencies: RepositoryMappingsManagerDependencies): RepositoryMappingsManager => {
  const manager = new RepositoryMappingsManager(dependencies);
  setRepositoryMappingsManager(manager);
  manager.init();
  return manager;
};
