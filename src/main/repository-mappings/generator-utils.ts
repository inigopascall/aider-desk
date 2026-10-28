import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { getMappingsDir, toMappingPath } from './mappings-state';

import type { RepositoryMappingFileState, RepositoryMappingGeneratorState, RepositoryMappingsSettings, RepositoryMappingsState } from '@common/types';

/** A single model call: system prompt and user prompt in, text out. */
export type RepositoryMappingsGenerate = (modelId: string, baseDir: string, systemPrompt: string, prompt: string, timeoutMs: number) => Promise<string>;

/** Everything a generator needs for one run. Generators record their result in `state.generators[id]`. */
export interface GeneratorContext {
  baseDir: string;
  settings: RepositoryMappingsSettings;
  /** Model for directory descriptions; null when none is configured. */
  descriptionModel: string | null;
  state: RepositoryMappingsState;
  /** Ignore fingerprints and the failure back-off. */
  force: boolean;
  /** ISO time of this run. */
  now: string;
  /** One line placed under each mapping file's title. */
  header: string;
  homeDir: string;
  generate: RepositoryMappingsGenerate;
}

/** A failed attempt is not retried with the same inputs for this long, unless forced. */
export const FAILURE_BACKOFF_MS = 10 * 60 * 1000;

export const sha1 = (value: string | Buffer): string => createHash('sha1').update(value).digest('hex');

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Whether a generator can keep its current output: same inputs as the last success with every file present, or same inputs as a recent failure. */
export const shouldSkipGenerator = async (
  context: GeneratorContext,
  generator: RepositoryMappingGeneratorState | undefined,
  fingerprint: string,
): Promise<boolean> => {
  if (context.force || !generator) {
    return false;
  }
  if (generator.fingerprint === fingerprint) {
    const present = await Promise.all(Object.keys(generator.files).map((key) => fileExists(path.join(context.baseDir, key))));
    if (present.every(Boolean)) {
      return true;
    }
  }
  if (generator.attemptedFingerprint === fingerprint && generator.lastFailureAt) {
    const sinceFailure = Date.parse(context.now) - Date.parse(generator.lastFailureAt);
    if (sinceFailure >= 0 && sinceFailure < FAILURE_BACKOFF_MS) {
      return true;
    }
  }
  return false;
};

/** Deletes every file a generator wrote and forgets the generator. */
export const removeGenerator = async (context: GeneratorContext, id: string): Promise<void> => {
  const generator = context.state.generators[id];
  if (!generator) {
    return;
  }
  for (const key of Object.keys(generator.files)) {
    await fs.rm(path.join(context.baseDir, key), { force: true });
  }
  delete context.state.generators[id];
};

/** Writes a mapping file atomically. Returns its state key (as listRepositoryMappingFiles keys it) and its fresh state. */
export const writeMappingFile = async (context: GeneratorContext, name: string, content: string): Promise<[string, RepositoryMappingFileState]> => {
  const dir = getMappingsDir(context.baseDir);
  const temporaryPath = path.join(dir, `.${name}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, path.join(dir, name));
  return [toMappingPath(name), { status: 'fresh', generatedAt: context.now }];
};
