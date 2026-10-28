import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { getTextFileStats } from '../file-stats';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createTempDir = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-stats-'));
  tempDirs.push(directory);
  return directory;
};

describe('getTextFileStats', () => {
  it('counts lines and tokens in a text file', async () => {
    const directory = await createTempDir();
    const file = path.join(directory, 'file.txt');
    await fs.writeFile(file, 'a\nb\nc');

    const stats = await getTextFileStats(file);

    expect(stats?.lines).toBe(3);
    expect(stats?.tokens).toBeGreaterThan(0);
  });

  it('returns updated stats after the file changes', async () => {
    const directory = await createTempDir();
    const file = path.join(directory, 'file.txt');
    await fs.writeFile(file, 'a\nb');
    await getTextFileStats(file);
    await fs.writeFile(file, 'a\nb\nc\nd');
    const later = new Date(Date.now() + 2000);
    await fs.utimes(file, later, later);

    const stats = await getTextFileStats(file);

    expect(stats?.lines).toBe(4);
  });

  it('returns null for a missing path', async () => {
    const directory = await createTempDir();
    expect(await getTextFileStats(path.join(directory, 'missing.txt'))).toBeNull();
  });

  it('returns null for a directory', async () => {
    const directory = await createTempDir();
    expect(await getTextFileStats(directory)).toBeNull();
  });
});
