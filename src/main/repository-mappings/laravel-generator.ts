import fs from 'fs/promises';
import path from 'path';

import { errorText, fileExists, removeGenerator, sha1, shouldSkipGenerator, writeMappingFile } from './generator-utils';
import { fillCommandTemplate, getLaravelMajorVersion, isLaravelComposerJson, mapProjectPath } from './laravel-command';
import { LARAVEL_EXPORT_PHP_SCRIPT } from './laravel-export-script';
import { formatLaravelMappings, parseLaravelExportOutput } from './laravel-format';
import { toMappingPath } from './mappings-state';
import { runShell } from './run-shell';

import type { GeneratorContext } from './generator-utils';
import type { LaravelMappingsOutput } from './laravel-format';
import type { RepositoryMappingFileState, RepositoryMappingsSettings } from '@common/types';
import type { Dirent } from 'fs';

export const LARAVEL_GENERATOR_ID = 'laravel';

/** Changes under these directories (or to composer.json / composer.lock) trigger a new export. */
const FINGERPRINT_DIRS = ['routes', 'app/Models', 'database/migrations'];
const FINGERPRINT_FILE_LIMIT = 5000;
const PRE_EXPORT_STDERR_CHARS = 500;
/** The export script relies on artisan JSON output available from Laravel 9. */
const MIN_LARAVEL_MAJOR = 9;

const readComposerJson = async (baseDir: string): Promise<string | null> => {
  try {
    return await fs.readFile(path.join(baseDir, 'composer.json'), 'utf8');
  } catch {
    return null;
  }
};

const collectFiles = async (baseDir: string, relativeDir: string, files: string[]): Promise<void> => {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(baseDir, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= FINGERPRINT_FILE_LIMIT) {
      return;
    }
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(baseDir, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
};

const laravelFingerprint = async (baseDir: string, settings: RepositoryMappingsSettings): Promise<string> => {
  const files: string[] = ['composer.json'];
  if (await fileExists(path.join(baseDir, 'composer.lock'))) {
    files.push('composer.lock');
  }
  for (const dir of FINGERPRINT_DIRS) {
    await collectFiles(baseDir, dir, files);
  }
  const lines: string[] = [];
  for (const file of files) {
    try {
      lines.push(`${file}\t${sha1(await fs.readFile(path.join(baseDir, file)))}`);
    } catch {
      lines.push(`${file}\tunreadable`);
    }
  }
  lines.sort();
  lines.push(JSON.stringify([settings.laravelCommandTemplate, settings.laravelPathRules, settings.laravelPreExportCommand]));
  return sha1(lines.join('\n'));
};

/** Runs the optional pre-export command and the export. Throws with a message for the sidebar on any failure. */
const exportMappings = async (context: GeneratorContext, projectDir: string, deadline: number): Promise<LaravelMappingsOutput> => {
  const { baseDir, settings } = context;

  const preExport = settings.laravelPreExportCommand.trim();
  if (preExport) {
    const result = await runShell(fillCommandTemplate(preExport, { projectDir, localProjectDir: baseDir }), baseDir, null, deadline - Date.now());
    if (result.timedOut || result.code !== 0) {
      const reason = result.timedOut ? 'timed out' : `exit ${result.code}`;
      throw new Error(`Pre-export command failed: ${reason}: ${result.stderrTail.slice(-PRE_EXPORT_STDERR_CHARS).trim()}`);
    }
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`Export timed out after ${settings.laravelTimeoutSeconds} s`);
  }
  const result = await runShell(
    fillCommandTemplate(settings.laravelCommandTemplate, { projectDir, command: 'php' }),
    baseDir,
    LARAVEL_EXPORT_PHP_SCRIPT,
    remaining,
  );
  if (result.overflow) {
    throw new Error('Export output exceeded 50 MB');
  }
  if (result.timedOut) {
    throw new Error(`Export timed out after ${settings.laravelTimeoutSeconds} s`);
  }
  if (result.code !== 0) {
    throw new Error(`Export command exited ${result.code}: ${result.stderrTail.trim()}`);
  }

  const output = formatLaravelMappings(parseLaravelExportOutput(result.stdout), context.header);
  if (output.bootError) {
    throw new Error(output.bootError);
  }
  return output;
};

/** Writes `schema.md`, `models.md` and `routes.md` for a Laravel project. On failure the previous files are kept and marked stale. */
export const runLaravelGenerator = async (context: GeneratorContext): Promise<void> => {
  const { baseDir, settings, state } = context;
  const composerJson = await readComposerJson(baseDir);
  if (!settings.laravelEnabled || composerJson === null || !isLaravelComposerJson(composerJson)) {
    await removeGenerator(context, LARAVEL_GENERATOR_ID);
    return;
  }

  let lockText: string | null = null;
  try {
    lockText = await fs.readFile(path.join(baseDir, 'composer.lock'), 'utf8');
  } catch {
    lockText = null;
  }
  const major = lockText === null ? null : getLaravelMajorVersion(lockText);
  if (major !== null && major < MIN_LARAVEL_MAJOR) {
    await removeGenerator(context, LARAVEL_GENERATOR_ID);
    return;
  }

  const previous = state.generators[LARAVEL_GENERATOR_ID];
  const previousFiles = previous?.files ?? {};
  const fingerprint = await laravelFingerprint(baseDir, settings);
  if (await shouldSkipGenerator(context, previous, fingerprint)) {
    return;
  }

  const deadline = Date.now() + settings.laravelTimeoutSeconds * 1000;
  const projectDir = mapProjectPath(baseDir, settings.laravelPathRules, context.homeDir);

  let output: LaravelMappingsOutput;
  try {
    output = await exportMappings(context, projectDir, deadline);
  } catch (error) {
    const failure = errorText(error);
    const staleFiles: Record<string, RepositoryMappingFileState> = {};
    for (const [key, file] of Object.entries(previousFiles)) {
      staleFiles[key] = { ...file, status: 'stale', message: failure };
    }
    state.generators[LARAVEL_GENERATOR_ID] = {
      fingerprint: previous?.fingerprint,
      attemptedFingerprint: fingerprint,
      attemptedAt: context.now,
      lastFailureAt: context.now,
      message: failure,
      files: staleFiles,
    };
    return;
  }

  const files: Record<string, RepositoryMappingFileState> = {};
  for (const [name, content] of Object.entries(output.files)) {
    if (typeof content !== 'string') {
      continue;
    }
    const [key, fileState] = await writeMappingFile(context, name, content);
    files[key] = fileState;
  }

  const failures: [string, string][] = [];
  for (const [name, failure] of Object.entries(output.failures)) {
    if (typeof failure !== 'string') {
      continue;
    }
    failures.push([name, failure]);
    const key = toMappingPath(name);
    const existing = previousFiles[key];
    if (existing && (await fileExists(path.join(baseDir, key)))) {
      files[key] = { ...existing, status: 'stale', message: failure };
    }
  }

  for (const key of Object.keys(previousFiles)) {
    if (!files[key]) {
      await fs.rm(path.join(baseDir, key), { force: true });
    }
  }

  const failed = failures.length > 0;
  state.generators[LARAVEL_GENERATOR_ID] = {
    fingerprint: failed ? previous?.fingerprint : fingerprint,
    attemptedFingerprint: fingerprint,
    attemptedAt: context.now,
    lastFailureAt: failed ? context.now : undefined,
    message: failed ? failures.map(([name, failure]) => `${name}: ${failure}`).join('; ') : undefined,
    files,
  };
};
