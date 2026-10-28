import fs from 'fs/promises';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteRepositoryMappingFile, ensureRepositoryMappingsInitialized, listRepositoryMappingFiles, runCustomMappingsScript } from '../repository-mappings';

import { AIDER_DESK_PROJECT_MAPPINGS_DIR } from '@/constants';
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

  it('initializes only the configured mappings directory', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);

    await ensureRepositoryMappingsInitialized(baseDir);

    expect(fs.mkdir).toHaveBeenCalledWith(path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR), { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).not.toHaveBeenCalled();
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

  it('returns false without running a missing custom mappings script', async () => {
    vi.mocked(fs.access).mockRejectedValueOnce(new Error('missing'));

    await expect(runCustomMappingsScript(baseDir)).resolves.toEqual({ ran: false });
    expect(execWithShellPath).not.toHaveBeenCalled();
  });

  it('runs a present custom mappings script', async () => {
    vi.mocked(fs.access).mockResolvedValueOnce(undefined);
    vi.mocked(execWithShellPath).mockResolvedValueOnce({} as never);

    await expect(runCustomMappingsScript(baseDir)).resolves.toEqual({ ran: true });
  });

  it('returns custom mappings script errors with stderr', async () => {
    vi.mocked(fs.access).mockResolvedValueOnce(undefined);
    vi.mocked(execWithShellPath).mockRejectedValueOnce(Object.assign(new Error('script failed'), { stderr: 'details' }));

    const result = await runCustomMappingsScript(baseDir);
    expect(result.ran).toBe(true);
    expect(result.error).toContain('script failed');
    expect(result.error).toContain('details');
  });

  it('deletes a mapping file within the mappings directory and rejects unsafe paths', async () => {
    vi.mocked(fs.rm).mockResolvedValue(undefined);

    await deleteRepositoryMappingFile(baseDir, `${AIDER_DESK_PROJECT_MAPPINGS_DIR}/repo-map.txt`.replace(/\\/g, '/'));
    expect(fs.rm).toHaveBeenCalledWith(path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR, 'repo-map.txt'), { force: true });

    await expect(deleteRepositoryMappingFile(baseDir, '../outside.txt')).rejects.toThrow('Invalid repository mapping file path');
    await expect(deleteRepositoryMappingFile(baseDir, `${AIDER_DESK_PROJECT_MAPPINGS_DIR}`.replace(/\\/g, '/'))).rejects.toThrow(
      'Invalid repository mapping file path',
    );
    expect(fs.rm).toHaveBeenCalledTimes(1);
  });
});
