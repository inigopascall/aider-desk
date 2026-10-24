import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_SNIPPET_MATCH_START, SEARCH_TASK_ROW_MESSAGE_ID } from '@common/types';

import { IndexMessageRow, IndexedTaskInfo, SearchIndex, VectorWrite, buildFtsQuery } from '../search-index';

const info: IndexedTaskInfo = { baseDir: '/p', taskId: 't1', name: 'Database work', topics: ['Indexing MySQL tables'] };

const rows: IndexMessageRow[] = [
  { messageId: 'm1', role: 'user', content: 'How do I speed up mysql joins?', timestamp: 1 },
  { messageId: 'm2', role: 'assistant', content: 'Add an index on the join column.', timestamp: 2 },
];

const query = (text: string): string => buildFtsQuery(text, 'all') as string;

describe('buildFtsQuery', () => {
  it('matches words as prefixes, short words exactly and quoted text as phrases', () => {
    expect(buildFtsQuery('mysql index', 'all')).toBe('"mysql"* AND "index"*');
    expect(buildFtsQuery('mysql index', 'any')).toBe('"mysql"* OR "index"*');
    expect(buildFtsQuery('go v2', 'all')).toBe('"go" AND "v2"');
    expect(buildFtsQuery('"Global Search" index', 'all')).toBe('"global search" AND "index"*');
  });

  it('returns null when nothing is searchable', () => {
    expect(buildFtsQuery('', 'all')).toBeNull();
    expect(buildFtsQuery('a ! ?', 'all')).toBeNull();
  });
});

describe('SearchIndex', () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex(':memory:');
    index.open();
  });

  afterEach(() => {
    index.close();
  });

  it('writes only new and changed messages when a task is re-indexed', () => {
    expect(index.replaceTask(info, rows, { mtimeMs: 10, size: 100 })).toEqual({ inserted: 2, removed: 0 });
    expect(index.replaceTask(info, rows)).toEqual({ inserted: 0, removed: 0 });

    const changedAnswer: IndexMessageRow = { ...rows[1], content: 'Add a composite index.' };
    const newMessage: IndexMessageRow = { messageId: 'm3', role: 'user', content: 'Thanks', timestamp: 3 };
    expect(index.replaceTask(info, [rows[0], changedAnswer, newMessage])).toEqual({ inserted: 2, removed: 1 });
    expect(index.replaceTask(info, [rows[0]])).toEqual({ inserted: 0, removed: 2 });

    expect(index.counts()).toEqual({ tasks: 1, messages: 1, vectors: 0 });
    expect(index.getFingerprint('/p', 't1')).toEqual({ mtimeMs: 10, size: 100 });
  });

  it('finds messages and the task row by keyword, with match markers', () => {
    index.replaceTask(info, rows);

    const hits = index.keywordSearch(query('mysql'), 10);
    expect(hits.map((hit) => hit.messageId).sort()).toEqual([SEARCH_TASK_ROW_MESSAGE_ID, 'm1'].sort());
    expect(hits.find((hit) => hit.messageId === 'm1')?.snippet).toContain(SEARCH_SNIPPET_MATCH_START);
    expect(index.keywordSearch(query('database'), 10).map((hit) => hit.role)).toEqual(['task']);
    expect(index.keywordSearch(query('nothingmatches'), 10)).toEqual([]);
  });

  it('updates task metadata without touching messages and deletes tasks completely', () => {
    index.replaceTask(info, rows);
    index.updateTaskInfo({ ...info, name: 'Renamed task', topics: [] });

    expect(index.getTask('/p', 't1')?.name).toBe('Renamed task');
    expect(index.keywordSearch(query('renamed'), 10).map((hit) => hit.messageId)).toEqual([SEARCH_TASK_ROW_MESSAGE_ID]);
    expect(index.counts().messages).toBe(2);

    index.deleteTask('/p', 't1');
    expect(index.counts()).toEqual({ tasks: 0, messages: 0, vectors: 0 });
    expect(index.listTasks()).toEqual([]);
  });

  it('stores vectors, searches them by cosine similarity and removes slots that are no longer wanted', () => {
    index.replaceTask(info, rows);
    const vectors: VectorWrite[] = [
      { slot: 'title', messageId: SEARCH_TASK_ROW_MESSAGE_ID, kind: 'title', text: 'Database work', textHash: 'h1', vector: Float32Array.from([1, 0, 0]) },
      { slot: 'user:m1', messageId: 'm1', kind: 'user', text: 'mysql joins', textHash: 'h2', vector: Float32Array.from([0, 1, 0]) },
    ];
    index.writeVectors('/p', 't1', vectors, new Set(['title', 'user:m1']));

    const matches = index.searchVectors(Float32Array.from([0, 1, 0]), 5, 0.5);
    expect(matches.map((match) => match.messageId)).toEqual(['m1']);
    expect(matches[0].score).toBeCloseTo(1);
    expect(Object.fromEntries(index.getVectorHashes('/p', 't1'))).toEqual({ title: 'h1', 'user:m1': 'h2' });

    index.writeVectors('/p', 't1', [], new Set(['title']));
    expect(index.counts().vectors).toBe(1);
    expect(index.searchVectors(Float32Array.from([0, 1, 0]), 5, 0.5)).toEqual([]);
  });
});

describe('SearchIndex scroll targets', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-nav-index-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('adds the scroll_target column to an existing database that lacks it, and keeps its rows', () => {
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(
      `CREATE TABLE nav_messages (id INTEGER PRIMARY KEY, base_dir TEXT NOT NULL, task_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL,
       content TEXT NOT NULL, content_hash TEXT NOT NULL DEFAULT '', timestamp INTEGER, UNIQUE (base_dir, task_id, message_id))`,
    );
    old
      .prepare('INSERT INTO nav_messages (base_dir, task_id, message_id, role, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run('/old', 't1', 'm1', 'user', 'An old question', 'h');
    old.close();

    const migrated = new SearchIndex(file);
    migrated.open();
    try {
      expect(migrated.getUserMessages('/old', 't1')).toEqual([{ messageId: 'm1', content: 'An old question' }]);
      migrated.replaceTask(info, [{ messageId: 'u4', role: 'user', content: 'Configure the zebra cache', scrollTarget: 'topic-compaction-a' }]);
      expect(migrated.getUserMessages('/p', 't1')).toEqual([{ messageId: 'u4', content: 'Configure the zebra cache', scrollTarget: 'topic-compaction-a' }]);
    } finally {
      migrated.close();
    }

    const reopened = new SearchIndex(file);
    reopened.open();
    try {
      expect(reopened.keywordSearch(query('zebra'), 10)[0]).toMatchObject({ messageId: 'u4', scrollTarget: 'topic-compaction-a' });
    } finally {
      reopened.close();
    }
  });

  it('returns the scroll target of a hit and rewrites a row whose scroll target alone changed', () => {
    const index = new SearchIndex(':memory:');
    index.open();
    try {
      const row: IndexMessageRow = { messageId: 'u4', role: 'user', content: 'Configure the zebra cache', scrollTarget: 'topic-compaction-a' };
      index.replaceTask(info, [row]);
      expect(index.keywordSearch(query('zebra'), 10)[0]).toMatchObject({ messageId: 'u4', scrollTarget: 'topic-compaction-a' });

      expect(index.replaceTask(info, [row])).toEqual({ inserted: 0, removed: 0 });
      expect(index.replaceTask(info, [{ ...row, scrollTarget: 'topic-compaction-b' }])).toEqual({ inserted: 1, removed: 1 });
      expect(index.keywordSearch(query('zebra'), 10)[0].scrollTarget).toBe('topic-compaction-b');

      expect(index.replaceTask(info, [{ messageId: 'u4', role: 'user', content: 'Configure the zebra cache' }])).toEqual({ inserted: 1, removed: 1 });
      expect(index.keywordSearch(query('zebra'), 10)[0].scrollTarget).toBeUndefined();
    } finally {
      index.close();
    }
  });
});
