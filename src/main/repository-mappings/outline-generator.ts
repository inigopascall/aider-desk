import fs from 'fs/promises';
import path from 'path';

import { encode } from 'gpt-tokenizer/model/gpt-4o';

import { errorText, fileExists, removeGenerator, shouldSkipGenerator, writeMappingFile } from './generator-utils';
import { OUTLINE_DESCRIPTIONS_FILE, getMappingsDir } from './mappings-state';
import {
  buildDescriptionPrompt,
  directoryFingerprint,
  groupOutlineDirectories,
  outlineFingerprint,
  parseDescriptionResponse,
  applyOutlineRules,
  readmeDescription,
  renderOutline,
} from './outline';

import type { GeneratorContext } from './generator-utils';
import type { DescriptionRequest, OutlineDirectory } from './outline';
import type { Dirent } from 'fs';

import { execWithShellPath } from '@/utils';
import logger from '@/logger';

export const OUTLINE_GENERATOR_ID = 'outline';
export const NO_DESCRIPTION_MODEL_MESSAGE = 'Directory descriptions need a model: set the topic map model in Settings → Tasks → Task Navigation.';

const OUTLINE_FILE = 'outline.md';
const DESCRIPTION_BATCH_SIZE = 20;
const DESCRIPTION_CONCURRENCY = 3;
const DESCRIPTION_TIMEOUT_MS = 120_000;
const EXCERPT_FILES = 3;
const EXCERPT_LINES = 15;
const EXCERPT_CHARS = 800;
const WALK_FILE_LIMIT = 50_000;
const EXISTS_CHECK_BATCH = 200;

interface DescriptionCache {
  version: 1;
  dirs: Record<string, { fingerprint: string; description: string }>;
}

const countTokens = (text: string): number => {
  try {
    return encode(text, { disallowedSpecial: new Set() }).length;
  } catch {
    return Math.ceil(text.length / 3);
  }
};

const toRelativePath = (directory: OutlineDirectory, file: string): string => (directory.dir ? `${directory.dir}/${file}` : file);

/** Walks the project when git cannot list it. Skips dot directories, node_modules and vendor. */
const walkProject = async (baseDir: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= WALK_FILE_LIMIT) {
        return;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') {
          continue;
        }
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(baseDir, fullPath).split(path.sep).join('/'));
      }
    }
  };
  await visit(baseDir);
  return files;
};

/** Tracked and untracked, non-ignored files that exist on disk. A stale git index can list deleted files, so each is checked. */
const listProjectFiles = async (baseDir: string): Promise<string[]> => {
  let listed: string[];
  try {
    const { stdout } = await execWithShellPath(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: baseDir,
      maxBuffer: 64 * 1024 * 1024,
    });
    listed = stdout.split('\0').filter(Boolean);
  } catch {
    return walkProject(baseDir);
  }
  const existing: string[] = [];
  for (let start = 0; start < listed.length; start += EXISTS_CHECK_BATCH) {
    const batch = listed.slice(start, start + EXISTS_CHECK_BATCH);
    const present = await Promise.all(batch.map((relativePath) => fileExists(path.join(baseDir, relativePath))));
    batch.forEach((relativePath, index) => {
      if (present[index]) {
        existing.push(relativePath);
      }
    });
  }
  return existing;
};

const readDescriptionCache = async (baseDir: string): Promise<DescriptionCache> => {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(getMappingsDir(baseDir), OUTLINE_DESCRIPTIONS_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'dirs' in parsed && parsed.dirs && typeof parsed.dirs === 'object') {
      return { version: 1, dirs: parsed.dirs as DescriptionCache['dirs'] };
    }
  } catch {
    // Missing or invalid: start empty.
  }
  return { version: 1, dirs: {} };
};

const writeDescriptionCache = async (baseDir: string, cache: DescriptionCache): Promise<void> => {
  await fs.writeFile(path.join(getMappingsDir(baseDir), OUTLINE_DESCRIPTIONS_FILE), JSON.stringify(cache, null, 2), 'utf8');
};

const readReadmeDescription = async (baseDir: string, directory: OutlineDirectory): Promise<string | undefined> => {
  const readme = directory.files.find((file) => !file.includes('/') && file.toLowerCase() === 'readme.md');
  if (!readme) {
    return undefined;
  }
  try {
    return readmeDescription(await fs.readFile(path.join(baseDir, toRelativePath(directory, readme)), 'utf8'));
  } catch {
    return undefined;
  }
};

const readExcerpts = async (baseDir: string, directory: OutlineDirectory): Promise<DescriptionRequest['excerpts']> => {
  const excerpts: DescriptionRequest['excerpts'] = [];
  const readme = directory.files.find((file) => !file.includes('/') && file.toLowerCase() === 'readme.md');
  const files = readme ? [readme, ...directory.files.filter((file) => file !== readme)] : directory.files;
  for (const file of files) {
    if (excerpts.length >= EXCERPT_FILES) {
      break;
    }
    try {
      const content = await fs.readFile(path.join(baseDir, toRelativePath(directory, file)), 'utf8');
      excerpts.push({ file, text: content.split('\n').slice(0, EXCERPT_LINES).join('\n').slice(0, EXCERPT_CHARS) });
    } catch {
      // Unreadable files are left out of the excerpts.
    }
  }
  return excerpts;
};

/** Asks the model for descriptions, in batches, a few at a time. A failed batch leaves its directories undescribed. */
const describeDirectories = async (
  context: GeneratorContext,
  directories: OutlineDirectory[],
  model: string,
): Promise<{ descriptions: Record<string, string>; error?: string }> => {
  const batches: OutlineDirectory[][] = [];
  for (let start = 0; start < directories.length; start += DESCRIPTION_BATCH_SIZE) {
    batches.push(directories.slice(start, start + DESCRIPTION_BATCH_SIZE));
  }
  const descriptions: Record<string, string> = {};
  let firstError: string | undefined;
  let nextBatch = 0;

  const worker = async (): Promise<void> => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch];
      nextBatch += 1;
      try {
        const requests: DescriptionRequest[] = await Promise.all(
          batch.map(async (directory) => ({ dir: directory.dir, files: directory.files, excerpts: await readExcerpts(context.baseDir, directory) })),
        );
        const { systemPrompt, prompt } = buildDescriptionPrompt(requests);
        const reply = await context.generate(model, context.baseDir, systemPrompt, prompt, DESCRIPTION_TIMEOUT_MS);
        const parsed = parseDescriptionResponse(
          reply,
          batch.map((directory) => directory.dir),
        );
        Object.assign(descriptions, parsed);
        const missing = batch.map((directory) => directory.dir).filter((dir) => !parsed[dir]);
        if (missing.length > 0) {
          firstError ??= `Missing descriptions for: ${missing.map((dir) => dir || '.').join(', ')}`;
        }
      } catch (error) {
        firstError ??= errorText(error);
        logger.warn('[RepositoryMappings] Directory descriptions failed', { baseDir: context.baseDir, error: errorText(error) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(DESCRIPTION_CONCURRENCY, batches.length) }, () => worker()));
  return { descriptions, error: firstError };
};

/** Writes `outline.md`: every source directory with its files and, when enabled, a one-line description. */
export const runOutlineGenerator = async (context: GeneratorContext): Promise<void> => {
  const { settings, state } = context;
  if (!settings.outlineEnabled) {
    await removeGenerator(context, OUTLINE_GENERATOR_ID);
    return;
  }

  const previous = state.generators[OUTLINE_GENERATOR_ID];
  const groupedDirectories = groupOutlineDirectories(await listProjectFiles(context.baseDir));
  const { directories, rulesApplied } = applyOutlineRules(groupedDirectories, settings.outlineRules);
  const fingerprint = outlineFingerprint(
    groupedDirectories,
    JSON.stringify({
      format: 4,
      descriptions: settings.outlineDescriptions,
      model: Boolean(context.descriptionModel),
      maxTokens: settings.outlineMaxTokens,
      rules: settings.outlineRules,
    }),
  );
  if (await shouldSkipGenerator(context, previous, fingerprint)) {
    return;
  }

  const descriptions: Record<string, string> = {};
  let message: string | undefined;
  let failed = false;

  if (settings.outlineDescriptions) {
    const cache = await readDescriptionCache(context.baseDir);
    const nextCache: DescriptionCache = { version: 1, dirs: {} };
    const needed: OutlineDirectory[] = [];

    for (const directory of directories) {
      const fromReadme = await readReadmeDescription(context.baseDir, directory);
      if (fromReadme) {
        descriptions[directory.dir] = fromReadme;
        continue;
      }
      const cached = cache.dirs[directory.dir];
      if (cached && cached.fingerprint === directoryFingerprint(directory)) {
        descriptions[directory.dir] = cached.description;
        nextCache.dirs[directory.dir] = cached;
        continue;
      }
      needed.push(directory);
    }

    if (needed.length > 0) {
      if (!context.descriptionModel) {
        message = NO_DESCRIPTION_MODEL_MESSAGE;
      } else {
        const result = await describeDirectories(context, needed, context.descriptionModel);
        for (const directory of needed) {
          const description = result.descriptions[directory.dir];
          if (description) {
            descriptions[directory.dir] = description;
            nextCache.dirs[directory.dir] = { fingerprint: directoryFingerprint(directory), description };
          }
        }
        if (result.error) {
          failed = true;
          message = `Some directory descriptions failed: ${result.error}`;
        }
      }
    }

    await writeDescriptionCache(context.baseDir, nextCache);
  }

  const rendered = renderOutline({ header: context.header, directories, descriptions, maxTokens: settings.outlineMaxTokens, countTokens, rulesApplied });
  const [key, fileState] = await writeMappingFile(context, OUTLINE_FILE, rendered.text);

  state.generators[OUTLINE_GENERATOR_ID] = {
    // Partial failures must not retain the attempted fingerprint as a success.
    fingerprint: failed ? (previous?.fingerprint === fingerprint ? undefined : previous?.fingerprint) : fingerprint,
    attemptedFingerprint: fingerprint,
    attemptedAt: context.now,
    lastFailureAt: failed ? context.now : undefined,
    message,
    files: { [key]: fileState },
  };
};
