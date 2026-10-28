import fs from 'fs/promises';
import path from 'path';

import type { ContextFile } from '@common/types';

import { AIDER_DESK_MAPPINGS_SCRIPT, AIDER_DESK_PROJECT_MAPPINGS_DIR } from '@/constants';
import { execWithShellPath } from '@/utils';

export const ensureRepositoryMappingsInitialized = async (baseDir: string): Promise<void> => {
  await fs.mkdir(path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR), { recursive: true });
};

export const listRepositoryMappingFiles = async (baseDir: string): Promise<ContextFile[]> => {
  const mappingsDir = path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR);

  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(entryPath)));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
    return files;
  };

  const files = await walk(mappingsDir);
  return files
    .map((filePath) => ({
      path: path.relative(baseDir, filePath).split(path.sep).join('/'),
      readOnly: true,
      source: 'repo-mapping' as const,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
};

export const deleteRepositoryMappingFile = async (baseDir: string, relativePath: string): Promise<void> => {
  const mappingsDir = path.resolve(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR);
  const target = path.resolve(baseDir, relativePath);
  const relative = path.relative(mappingsDir, target);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid repository mapping file path: ${relativePath}`);
  }

  await fs.rm(target, { force: true });
};

/** Runs the project's optional `.aider-desk/mappings.sh` for custom mappings. `ran` is false when the project has none. */
export const runCustomMappingsScript = async (baseDir: string): Promise<{ ran: boolean; error?: string }> => {
  const scriptPath = path.join(baseDir, AIDER_DESK_MAPPINGS_SCRIPT);
  try {
    await fs.access(scriptPath);
  } catch {
    return { ran: false };
  }
  try {
    await execWithShellPath(`bash "${scriptPath}"`, { cwd: baseDir, maxBuffer: 16 * 1024 * 1024 });
    return { ran: true };
  } catch (error) {
    const err = error as Error & { stderr?: string };
    return { ran: true, error: [err.message, err.stderr].filter(Boolean).join('\n') };
  }
};
