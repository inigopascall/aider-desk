import { promises as fs } from 'fs';
import path from 'path';

import { CompactionArchiveInfo, ContextMessage } from '@common/types';

import type { TopicCompactionSidecar } from './topic-compaction';

import { AIDER_DESK_TASKS_DIR } from '@/constants';
import { atomicWriteJsonFile } from '@/utils/atomic-write';

/** Folder in a task folder that holds the sidecars of topic compactions and the archives made before built-in compactions. */
export const TOPIC_COMPACTIONS_DIR = 'topic-compactions';
export const COMPACTION_ARCHIVE_PREFIX = 'archive-';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const JSON_EXTENSION = '.json';

/** A conversation saved before a built-in compaction removed the recap of a topic compaction, or before an archive was restored. */
export interface CompactionArchive extends CompactionArchiveInfo {
  version: 1;
  messages: ContextMessage[];
}

/** True for an id that can be used as a file name inside the task folder: no separators, no leading dot, no `..`. */
export const isSafeCompactionFileId = (id: string): boolean => typeof id === 'string' && SAFE_ID_PATTERN.test(id) && !id.includes('..');

export const isCompactionArchiveId = (id: string): boolean => isSafeCompactionFileId(id) && id.startsWith(COMPACTION_ARCHIVE_PREFIX);

const assertSafeId = (id: string, kind: string): void => {
  if (!isSafeCompactionFileId(id)) {
    throw new Error(`Invalid ${kind}: ${String(id).slice(0, 80)}`);
  }
};

export const getTopicCompactionsDir = (baseDir: string, taskId: string): string => {
  assertSafeId(taskId, 'task id');
  return path.join(baseDir, AIDER_DESK_TASKS_DIR, taskId, TOPIC_COMPACTIONS_DIR);
};

export const getCompactionSidecarPath = (baseDir: string, taskId: string, compactionId: string): string => {
  assertSafeId(compactionId, 'compaction id');
  return path.join(getTopicCompactionsDir(baseDir, taskId), `${compactionId}${JSON_EXTENSION}`);
};

export const getCompactionArchivePath = (baseDir: string, taskId: string, archiveId: string): string => {
  if (!isCompactionArchiveId(archiveId)) {
    throw new Error(`Invalid archive id: ${String(archiveId).slice(0, 80)}`);
  }
  return path.join(getTopicCompactionsDir(baseDir, taskId), `${archiveId}${JSON_EXTENSION}`);
};

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Parses a JSON file; null when it does not exist. */
const readJsonFile = async (filePath: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
};

const isSidecar = (value: unknown): value is TopicCompactionSidecar => {
  const record = value as Partial<TopicCompactionSidecar> | null;
  return (
    !!record &&
    typeof record === 'object' &&
    record.version === 1 &&
    typeof record.id === 'string' &&
    typeof record.summaryMessageId === 'string' &&
    Array.isArray(record.originalMessages)
  );
};

const isArchive = (value: unknown): value is CompactionArchive => {
  const record = value as Partial<CompactionArchive> | null;
  return !!record && typeof record === 'object' && record.version === 1 && typeof record.id === 'string' && Array.isArray(record.messages);
};

/** Writes the sidecar of a compaction: the original messages, kept unchanged so that the compaction can be undone. */
export const writeCompactionSidecar = async (baseDir: string, taskId: string, sidecar: TopicCompactionSidecar): Promise<void> => {
  await atomicWriteJsonFile(getCompactionSidecarPath(baseDir, taskId, sidecar.id), sidecar);
};

export const readCompactionSidecar = async (baseDir: string, taskId: string, compactionId: string): Promise<TopicCompactionSidecar | null> => {
  const value = await readJsonFile(getCompactionSidecarPath(baseDir, taskId, compactionId));
  return isSidecar(value) ? value : null;
};

export const deleteCompactionSidecar = async (baseDir: string, taskId: string, compactionId: string): Promise<void> => {
  try {
    await fs.unlink(getCompactionSidecarPath(baseDir, taskId, compactionId));
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
};

/** Every readable sidecar of a task, by file name; none when the task has no compactions. */
export const listCompactionSidecars = async (baseDir: string, taskId: string): Promise<TopicCompactionSidecar[]> => {
  let names: string[];
  try {
    names = await fs.readdir(getTopicCompactionsDir(baseDir, taskId));
  } catch {
    return [];
  }
  const sidecars: TopicCompactionSidecar[] = [];
  for (const name of names.sort()) {
    const id = name.endsWith(JSON_EXTENSION) ? name.slice(0, -JSON_EXTENSION.length) : '';
    if (!isSafeCompactionFileId(id) || id.startsWith(COMPACTION_ARCHIVE_PREFIX)) {
      continue;
    }
    try {
      const sidecar = await readCompactionSidecar(baseDir, taskId, id);
      if (sidecar) {
        sidecars.push(sidecar);
      }
    } catch {
      // A file that cannot be read or parsed is not a sidecar.
    }
  }
  return sidecars;
};

/**
 * Archives a conversation in the task folder as `archive-<ISO time with : replaced by ->.json`; a second archive in the
 * same millisecond gets a numeric suffix.
 */
export const writeCompactionArchive = async (
  baseDir: string,
  taskId: string,
  reason: CompactionArchiveInfo['reason'],
  messages: ContextMessage[],
  now = new Date(),
): Promise<CompactionArchiveInfo> => {
  const createdAt = now.toISOString();
  const stem = `${COMPACTION_ARCHIVE_PREFIX}${createdAt.replace(/:/g, '-')}`;
  let id = stem;
  for (let suffix = 2; await fileExists(getCompactionArchivePath(baseDir, taskId, id)); suffix++) {
    id = `${stem}-${suffix}`;
  }
  const archive: CompactionArchive = { version: 1, id, createdAt, reason, messages };
  await atomicWriteJsonFile(getCompactionArchivePath(baseDir, taskId, id), archive);
  return { id, createdAt, reason };
};

export const readCompactionArchive = async (baseDir: string, taskId: string, archiveId: string): Promise<CompactionArchive | null> => {
  const value = await readJsonFile(getCompactionArchivePath(baseDir, taskId, archiveId));
  return isArchive(value) ? value : null;
};
