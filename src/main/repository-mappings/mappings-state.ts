import fs from 'fs/promises';
import path from 'path';

import type { RepositoryMappingsState } from '@common/types';

import { AIDER_DESK_PROJECT_MAPPINGS_DIR } from '@/constants';
import { atomicWriteJsonFile } from '@/utils/atomic-write';

export const MAPPINGS_STATE_FILE = '.state.json';
export const OUTLINE_DESCRIPTIONS_FILE = '.outline-descriptions.json';
export const REPOSITORY_MAPPING_GENERATOR_LABELS: Record<string, string> = { outline: 'Codebase outline', laravel: 'Laravel mappings' };

export const getMappingsDir = (baseDir: string): string => path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR);

export const toMappingPath = (fileName: string): string => path.join(AIDER_DESK_PROJECT_MAPPINGS_DIR, fileName).split(path.sep).join('/');

export const readRepositoryMappingsState = async (baseDir: string): Promise<RepositoryMappingsState> => {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(getMappingsDir(baseDir), MAPPINGS_STATE_FILE), 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as { version?: unknown }).version !== 1 ||
      typeof (value as { generators?: unknown }).generators !== 'object'
    ) {
      return { version: 1, generators: {} };
    }
    return value as RepositoryMappingsState;
  } catch {
    return { version: 1, generators: {} };
  }
};

export const writeRepositoryMappingsState = async (baseDir: string, state: RepositoryMappingsState): Promise<void> => {
  await atomicWriteJsonFile(path.join(getMappingsDir(baseDir), MAPPINGS_STATE_FILE), state);
};
