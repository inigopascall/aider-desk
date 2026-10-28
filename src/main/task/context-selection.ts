import path from 'path';
import { homedir } from 'os';

import {
  AIDER_MODES,
  AgentProfile,
  ContextDelivery,
  ContextFile,
  ContextManifestEntry,
  ContextEntryStatus,
  ContextNotSentReason,
  ContextPlacement,
  Mode,
  TaskContextManifest,
} from '@common/types';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif', '.heic', '.heif']);

export const isImageFilePath = (filePath: string): boolean => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());

/** Resolves a selection key (`~/…`, project-relative or absolute) to an absolute path. */
export const resolveSelectionPath = (filePath: string, projectDir: string, homeDir: string = homedir()): string => {
  if (filePath === '~') {
    return path.resolve(homeDir);
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.resolve(homeDir, filePath.slice(2));
  }
  return path.resolve(projectDir, filePath);
};

const relativeInside = (parentDir: string, target: string): string | null => {
  const relative = path.relative(path.resolve(parentDir), target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
};

export const isPathInside = (parentDir: string, target: string): boolean => relativeInside(parentDir, target) !== null;

const toForwardSlashes = (value: string): string => value.split(path.sep).join('/');

/** Forward slashes: project-relative, `~/…` under the home dir, otherwise absolute. */
export const toDisplayPath = (filePath: string, projectDir: string, homeDir: string = homedir()): string => {
  const absolutePath = resolveSelectionPath(filePath, projectDir, homeDir);
  const projectRelative = relativeInside(projectDir, absolutePath);
  if (projectRelative !== null) {
    return toForwardSlashes(projectRelative);
  }
  const homeRelative = relativeInside(homeDir, absolutePath);
  if (homeRelative !== null) {
    return `~/${toForwardSlashes(homeRelative)}`;
  }
  return toForwardSlashes(absolutePath);
};

export const getRuleFileAbsolutePaths = (ruleFiles: ContextFile[], projectDir: string, homeDir: string = homedir()): Set<string> =>
  new Set(ruleFiles.map((file) => resolveSelectionPath(file.path, projectDir, homeDir)));

export interface ContextManifestInput {
  baseDir: string;
  taskId: string;
  mode: Mode;
  profile: AgentProfile | null;
  addRuleFiles: boolean;
  /** Absolute path of the project's `.aider-desk/rules` directory. */
  projectRulesDir: string;
  /** All rule files, ticked or not, in prompt order. */
  ruleFiles: ContextFile[];
  disabledRuleFiles: string[];
  /** All mapping files, ticked or not. */
  mappingFiles: ContextFile[];
  disabledMappingFiles: string[];
  /** Status per mapping path (stale, over budget). */
  mappingStatuses?: Record<string, ContextEntryStatus>;
  /** Problems with the mapping generators as a whole. */
  mappingNotices?: string[];
  /** All context files, including disabled ones, in insertion order. */
  contextFiles: ContextFile[];
  /** Status per context file path (truncated). */
  fileStatuses?: Record<string, ContextEntryStatus>;
  homeDir?: string;
}

type Outcome = { delivery: Exclude<ContextDelivery, 'none'> } | { reason: ContextNotSentReason };

const toEntry = (
  file: ContextFile,
  baseDir: string,
  homeDir: string,
  selected: boolean,
  outcome: Outcome,
  status?: ContextEntryStatus,
): ContextManifestEntry => {
  const entry: ContextManifestEntry = {
    path: file.path,
    displayPath: toDisplayPath(file.path, baseDir, homeDir),
    readOnly: Boolean(file.readOnly),
    ...(file.source ? { source: file.source } : {}),
    selected,
    delivery: 'none',
    ...(selected && status ? { status } : {}),
  };
  if (!selected) {
    return { ...entry, notSentReason: 'unselected' };
  }
  if ('reason' in outcome) {
    return { ...entry, notSentReason: outcome.reason };
  }
  return { ...entry, delivery: outcome.delivery };
};

/**
 * Describes, per section, which files reach the model and how. Mirrors the prompt path:
 * rules go to the system prompt (agent modes) or to Aider as `--read` files (Aider modes);
 * mappings and context files go into the message list around the conversation history.
 */
export const buildContextManifest = (input: ContextManifestInput): TaskContextManifest => {
  const homeDir = input.homeDir ?? homedir();
  const isAiderMode = AIDER_MODES.includes(input.mode);
  const includeContextFiles = Boolean(input.profile?.includeContextFiles);
  const includeRepoMappings = Boolean(input.profile?.includeRepoMappings);
  const disabledRules = new Set(input.disabledRuleFiles);
  const disabledMappings = new Set(input.disabledMappingFiles);
  const rulePaths = getRuleFileAbsolutePaths(input.ruleFiles, input.baseDir, homeDir);
  const enabledContextPaths = new Set(
    input.contextFiles.filter((file) => !file.disabled).map((file) => resolveSelectionPath(file.path, input.baseDir, homeDir)),
  );

  const ruleEntries = input.ruleFiles.map((file) => {
    let outcome: Outcome = { delivery: 'content' };
    if (isAiderMode) {
      const absolutePath = resolveSelectionPath(file.path, input.baseDir, homeDir);
      if (enabledContextPaths.has(absolutePath)) {
        // Also an enabled context entry, so Aider receives it as a context file.
        outcome = { delivery: 'content' };
      } else if (isPathInside(input.projectRulesDir, absolutePath)) {
        outcome = input.addRuleFiles ? { delivery: 'content' } : { reason: 'aider-rule-files-disabled' };
      } else {
        outcome = { reason: 'aider-mode' };
      }
    }
    return toEntry(file, input.baseDir, homeDir, !disabledRules.has(file.path), outcome);
  });

  const mappingOutcome: Outcome = isAiderMode
    ? { reason: 'aider-mode' }
    : includeRepoMappings
      ? { delivery: 'content' }
      : { reason: 'profile-excludes-mappings' };
  const mappingEntries = input.mappingFiles.map((file) =>
    toEntry(file, input.baseDir, homeDir, !disabledMappings.has(file.path), mappingOutcome, input.mappingStatuses?.[file.path]),
  );

  // A path that is also a rule file is governed by the rule selection and listed only under rules.
  const ordinaryFiles = input.contextFiles.filter((file) => !rulePaths.has(resolveSelectionPath(file.path, input.baseDir, homeDir)));
  const orderedFiles =
    !isAiderMode && includeContextFiles ? [...ordinaryFiles.filter((file) => file.readOnly), ...ordinaryFiles.filter((file) => !file.readOnly)] : ordinaryFiles;
  const fileEntries = orderedFiles.map((file) => {
    const outcome: Outcome = isAiderMode || includeContextFiles || isImageFilePath(file.path) ? { delivery: 'content' } : { delivery: 'path-only' };
    return toEntry(file, input.baseDir, homeDir, !file.disabled, outcome, input.fileStatuses?.[file.path]);
  });

  const messagesPlacement: ContextPlacement = isAiderMode ? 'aider-context' : includeContextFiles ? 'messages-after-history' : 'messages-before-history';

  return {
    baseDir: input.baseDir,
    taskId: input.taskId,
    mode: input.mode,
    ...(input.profile ? { agentProfileId: input.profile.id } : {}),
    sections: [
      { id: 'rules', placement: isAiderMode ? 'aider-context' : 'system-prompt', entries: ruleEntries },
      {
        id: 'mappings',
        placement: messagesPlacement,
        entries: mappingEntries,
        ...(input.mappingNotices && input.mappingNotices.length > 0 ? { notices: input.mappingNotices } : {}),
      },
      { id: 'files', placement: messagesPlacement, entries: fileEntries },
    ],
  };
};
