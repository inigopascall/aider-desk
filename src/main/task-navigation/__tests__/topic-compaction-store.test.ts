import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextMessage } from '@common/types';

import { TopicCompactionSidecar } from '../topic-compaction';
import {
  deleteCompactionSidecar,
  getCompactionSidecarPath,
  getTopicCompactionsDir,
  isCompactionArchiveId,
  isSafeCompactionFileId,
  listCompactionSidecars,
  readCompactionArchive,
  readCompactionSidecar,
  writeCompactionArchive,
  writeCompactionSidecar,
} from '../topic-compaction-store';

import { AIDER_DESK_TASKS_DIR } from '@/constants';

const messages = [
  { id: 'u1', role: 'user', content: 'Question' },
  { id: 'a1', role: 'assistant', content: 'Answer' },
] as ContextMessage[];

const sidecar = (id: string): TopicCompactionSidecar => ({
  version: 1,
  id,
  createdAt: '2026-10-24T10:00:00.000Z',
  level: 3,
  target: { topicIndex: 0, firstMessageId: 'u1' },
  summaryMessageId: `topic-compaction-${id}`,
  promptMessageId: `topic-compaction-${id}-prompt`,
  messageCount: 2,
  sourceCharacters: 14,
  summaryCharacters: 5,
  originalMessages: messages,
});

describe('topic compaction store', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-nav-store-'));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes, reads, lists and deletes sidecars in the task folder', async () => {
    await writeCompactionSidecar(baseDir, 'task-1', sidecar('c1'));
    await writeCompactionSidecar(baseDir, 'task-1', sidecar('c2'));

    expect(getCompactionSidecarPath(baseDir, 'task-1', 'c1')).toBe(path.join(baseDir, AIDER_DESK_TASKS_DIR, 'task-1', 'topic-compactions', 'c1.json'));
    expect(await readCompactionSidecar(baseDir, 'task-1', 'c1')).toEqual(sidecar('c1'));
    expect((await listCompactionSidecars(baseDir, 'task-1')).map((item) => item.id)).toEqual(['c1', 'c2']);

    await deleteCompactionSidecar(baseDir, 'task-1', 'c1');
    await deleteCompactionSidecar(baseDir, 'task-1', 'c1');
    expect(await readCompactionSidecar(baseDir, 'task-1', 'c1')).toBeNull();
    expect((await listCompactionSidecars(baseDir, 'task-1')).map((item) => item.id)).toEqual(['c2']);
  });

  it('lists nothing for a task without compactions and skips archives and files that are not sidecars', async () => {
    expect(await listCompactionSidecars(baseDir, 'task-1')).toEqual([]);

    await writeCompactionSidecar(baseDir, 'task-1', sidecar('c1'));
    await writeCompactionArchive(baseDir, 'task-1', 'built-in-compaction', messages);
    await fs.writeFile(path.join(getTopicCompactionsDir(baseDir, 'task-1'), 'broken.json'), '{');

    expect((await listCompactionSidecars(baseDir, 'task-1')).map((item) => item.id)).toEqual(['c1']);
  });

  it('rejects ids that could leave the task folder', () => {
    for (const id of ['../escape', 'a/b', 'a\\b', '', '..', '.hidden']) {
      expect(isSafeCompactionFileId(id)).toBe(false);
    }
    expect(isSafeCompactionFileId('0f6c2e1a-9b7d-4c1e-8f3a-2b5d6e7f8a9b')).toBe(true);
    expect(() => getCompactionSidecarPath(baseDir, 'task-1', '../escape')).toThrow();
    expect(() => getTopicCompactionsDir(baseDir, '../other')).toThrow();
  });

  it('writes archives named after their time and reads them back', async () => {
    const now = new Date('2026-10-24T10:00:00.000Z');
    const first = await writeCompactionArchive(baseDir, 'task-1', 'built-in-compaction', messages, now);
    const second = await writeCompactionArchive(baseDir, 'task-1', 'before-restore', messages, now);

    expect(first).toEqual({ id: 'archive-2026-10-24T10-00-00.000Z', createdAt: '2026-10-24T10:00:00.000Z', reason: 'built-in-compaction' });
    expect(second.id).toBe('archive-2026-10-24T10-00-00.000Z-2');
    expect(await fs.readdir(getTopicCompactionsDir(baseDir, 'task-1'))).toEqual(
      expect.arrayContaining(['archive-2026-10-24T10-00-00.000Z.json', 'archive-2026-10-24T10-00-00.000Z-2.json']),
    );
    expect(await readCompactionArchive(baseDir, 'task-1', first.id)).toEqual({ version: 1, ...first, messages });
    expect(await readCompactionArchive(baseDir, 'task-1', 'archive-missing')).toBeNull();
    expect(isCompactionArchiveId(first.id)).toBe(true);
    expect(isCompactionArchiveId('c1')).toBe(false);
  });
});
