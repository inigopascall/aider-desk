import fs from 'fs/promises';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureRepositoryMappingsInitialized,
  getDefaultMappingsScript,
  listRepositoryMappingFiles,
  runRepositoryMappingsGenerator,
} from '../repository-mappings';

import { AIDER_DESK_MAPPINGS_SCRIPT, AIDER_DESK_PROJECT_MAPPINGS_DIR } from '@/constants';
import { execWithShellPath } from '@/utils';

vi.mock('fs/promises');
vi.mock('@/utils', () => ({
  execWithShellPath: vi.fn(),
}));

describe('repository mappings', () => {
  const baseDir = '/project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes the configured directory and default script without overwriting an existing script', async () => {
    vi.mocked(fs.access).mockRejectedValueOnce(new Error('missing'));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await ensureRepositoryMappingsInitialized(baseDir);

    expect(fs.mkdir).toHaveBeenCalledWith(path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(baseDir, AIDER_DESK_MAPPINGS_SCRIPT), getDefaultMappingsScript(), 'utf8');

    vi.mocked(fs.access).mockResolvedValue(undefined);
    await ensureRepositoryMappingsInitialized(baseDir);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('discovers recursive non-dot mapping files as sorted project-relative POSIX read-only files', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([
        { name: 'nested', isDirectory: () => true, isFile: () => false },
        { name: 'z.md', isDirectory: () => false, isFile: () => true },
        { name: '.hidden', isDirectory: () => false, isFile: () => true },
      ] as any)
      .mockResolvedValueOnce([
        { name: 'a.json', isDirectory: () => false, isFile: () => true },
        { name: '.private', isDirectory: () => false, isFile: () => true },
      ] as any);

    await expect(listRepositoryMappingFiles(baseDir)).resolves.toEqual([
      { path: `${AIDER_DESK_PROJECT_MAPPINGS_DIR}/nested/a.json`.replace(/\\/g, '/'), readOnly: true, source: 'repo-mapping' },
      { path: `${AIDER_DESK_PROJECT_MAPPINGS_DIR}/z.md`.replace(/\\/g, '/'), readOnly: true, source: 'repo-mapping' },
    ]);
  });

  it('returns success when the generator succeeds and failure details when it fails', async () => {
    vi.mocked(execWithShellPath).mockResolvedValueOnce({} as never);
    await expect(runRepositoryMappingsGenerator(baseDir)).resolves.toEqual({ success: true });

    vi.mocked(execWithShellPath).mockRejectedValueOnce(Object.assign(new Error('generator failed'), { stderr: 'details' }));
    await expect(runRepositoryMappingsGenerator(baseDir)).resolves.toEqual({ success: false, error: 'generator failed\ndetails' });
  });

  it('uses the configured mappings directory in the generated script', () => {
    expect(getDefaultMappingsScript()).toContain(`OUTPUT_DIR="${AIDER_DESK_PROJECT_MAPPINGS_DIR}"`);
  });
});
