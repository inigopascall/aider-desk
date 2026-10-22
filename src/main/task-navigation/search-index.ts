import { DatabaseSync } from 'node:sqlite';

import { SEARCH_TASK_ROW_MESSAGE_ID, SearchHitRole } from '@common/types';

import { hashText } from './message-text';

export interface IndexedTaskInfo {
  baseDir: string;
  taskId: string;
  name: string;
  taskNumber?: number;
  state?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** Topic summaries of the task's topic map, in order. */
  topics?: string[];
}

export interface ContextFingerprint {
  mtimeMs: number;
  size: number;
}

export interface IndexMessageRow {
  messageId: string;
  role: SearchHitRole;
  content: string;
  timestamp?: number;
}

export interface ReplaceTaskResult {
  /** Messages written because they are new or their text changed. */
  inserted: number;
  /** Messages removed because they are gone or their text changed. */
  removed: number;
}

export interface KeywordHit {
  baseDir: string;
  taskId: string;
  messageId: string;
  role: SearchHitRole;
  snippet: string;
  timestamp?: number;
  /** bm25 rank: lower is better. */
  rank: number;
}

export type VectorKind = 'title' | 'topic' | 'user';

export interface VectorWrite {
  slot: string;
  messageId: string;
  kind: VectorKind;
  text: string;
  textHash: string;
  vector: Float32Array;
}

export interface VectorMatch {
  baseDir: string;
  taskId: string;
  messageId: string;
  kind: VectorKind;
  text: string;
  score: number;
}

interface VectorCacheEntry {
  baseDir: string;
  taskId: string;
  messageId: string;
  kind: VectorKind;
  text: string;
}

interface VectorCache {
  entries: VectorCacheEntry[];
  matrix: Float32Array;
  dimension: number;
}

interface TaskRow {
  baseDir: string;
  taskId: string;
  name: string;
  taskNumber: number | null;
  state: string | null;
  archived: number;
  createdAt: string | null;
  updatedAt: string | null;
  topicsJson: string | null;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nav_tasks (
    base_dir TEXT NOT NULL,
    task_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    task_number INTEGER,
    state TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT,
    topics_json TEXT,
    context_mtime REAL,
    context_size INTEGER,
    PRIMARY KEY (base_dir, task_id)
  );
  CREATE TABLE IF NOT EXISTS nav_messages (
    id INTEGER PRIMARY KEY,
    base_dir TEXT NOT NULL,
    task_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    timestamp INTEGER,
    UNIQUE (base_dir, task_id, message_id)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS nav_messages_fts USING fts5(content, content='nav_messages', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
  CREATE TRIGGER IF NOT EXISTS nav_messages_ai AFTER INSERT ON nav_messages BEGIN
    INSERT INTO nav_messages_fts (rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS nav_messages_ad AFTER DELETE ON nav_messages BEGIN
    INSERT INTO nav_messages_fts (nav_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS nav_messages_au AFTER UPDATE ON nav_messages BEGIN
    INSERT INTO nav_messages_fts (nav_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO nav_messages_fts (rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TABLE IF NOT EXISTS nav_vectors (
    id INTEGER PRIMARY KEY,
    base_dir TEXT NOT NULL,
    task_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    vector BLOB NOT NULL,
    UNIQUE (base_dir, task_id, slot)
  );
  CREATE INDEX IF NOT EXISTS nav_messages_task ON nav_messages (base_dir, task_id);
  CREATE INDEX IF NOT EXISTS nav_vectors_task ON nav_vectors (base_dir, task_id);
`;

const INSERT_MESSAGE_SQL = 'INSERT INTO nav_messages (base_dir, task_id, message_id, role, content, content_hash, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)';

const toNullable = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

const toTaskInfo = (row: TaskRow): IndexedTaskInfo => {
  let topics: string[] | undefined;
  if (row.topicsJson) {
    try {
      const parsed: unknown = JSON.parse(row.topicsJson);
      topics = Array.isArray(parsed) ? parsed.filter((topic): topic is string => typeof topic === 'string') : undefined;
    } catch {
      topics = undefined;
    }
  }
  return {
    baseDir: row.baseDir,
    taskId: row.taskId,
    name: row.name,
    taskNumber: row.taskNumber ?? undefined,
    state: row.state ?? undefined,
    archived: row.archived === 1,
    createdAt: row.createdAt ?? undefined,
    updatedAt: row.updatedAt ?? undefined,
    topics,
  };
};

const TASK_COLUMNS =
  'base_dir AS baseDir, task_id AS taskId, name, task_number AS taskNumber, state, archived, created_at AS createdAt, updated_at AS updatedAt, topics_json AS topicsJson';

const WORD_PATTERN = /[\p{L}\p{N}_]+/gu;
const PHRASE_PATTERN = /"([^"]+)"/g;

/**
 * Builds an FTS5 query from free text. Quoted phrases are matched as phrases; other words of three or more characters
 * are matched as prefixes, shorter ones exactly.
 * Returns null when the text contains nothing searchable.
 */
export const buildFtsQuery = (query: string, mode: 'all' | 'any'): string | null => {
  const terms: string[] = [];

  for (const match of query.matchAll(PHRASE_PATTERN)) {
    const words = match[1].toLowerCase().match(WORD_PATTERN);
    if (words && words.length > 0) {
      terms.push(`"${words.join(' ')}"`);
    }
  }

  const remainder = query.replace(PHRASE_PATTERN, ' ').toLowerCase();
  const words = new Set(remainder.match(WORD_PATTERN) ?? []);
  for (const word of words) {
    if (word.length < 2 && !/\d/.test(word)) {
      continue;
    }
    terms.push(word.length >= 3 ? `"${word}"*` : `"${word}"`);
  }

  if (terms.length === 0) {
    return null;
  }
  return terms.slice(0, 16).join(mode === 'all' ? ' AND ' : ' OR ');
};

/** SQLite store for the global task search: an FTS5 keyword index over messages and a small vector table. */
export class SearchIndex {
  private db: DatabaseSync | null = null;
  private vectorCache: VectorCache | null = null;

  constructor(private readonly dbPath: string) {}

  open(): void {
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA_SQL);
    this.db = db;
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.vectorCache = null;
  }

  private get database(): DatabaseSync {
    if (!this.db) {
      throw new Error('The task search index is not open');
    }
    return this.db;
  }

  private transaction<T>(work: (db: DatabaseSync) => T): T {
    const db = this.database;
    db.exec('BEGIN');
    try {
      const result = work(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private writeTaskInfo(db: DatabaseSync, info: IndexedTaskInfo, fingerprint?: ContextFingerprint | null): void {
    db.prepare(
      `INSERT INTO nav_tasks (base_dir, task_id, name, task_number, state, archived, created_at, updated_at, topics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (base_dir, task_id) DO UPDATE SET
         name = excluded.name, task_number = excluded.task_number, state = excluded.state, archived = excluded.archived,
         created_at = excluded.created_at, updated_at = excluded.updated_at, topics_json = excluded.topics_json`,
    ).run(
      info.baseDir,
      info.taskId,
      info.name,
      toNullable(info.taskNumber),
      toNullable(info.state),
      info.archived ? 1 : 0,
      toNullable(info.createdAt),
      toNullable(info.updatedAt),
      info.topics && info.topics.length > 0 ? JSON.stringify(info.topics) : null,
    );

    if (fingerprint !== undefined) {
      db.prepare('UPDATE nav_tasks SET context_mtime = ?, context_size = ? WHERE base_dir = ? AND task_id = ?').run(
        fingerprint ? fingerprint.mtimeMs : null,
        fingerprint ? fingerprint.size : null,
        info.baseDir,
        info.taskId,
      );
    }

    db.prepare('DELETE FROM nav_messages WHERE base_dir = ? AND task_id = ? AND message_id = ?').run(info.baseDir, info.taskId, SEARCH_TASK_ROW_MESSAGE_ID);
    const taskRowContent = [info.name, ...(info.topics ?? [])].filter(Boolean).join('\n');
    if (taskRowContent) {
      db.prepare(INSERT_MESSAGE_SQL).run(info.baseDir, info.taskId, SEARCH_TASK_ROW_MESSAGE_ID, 'task', taskRowContent, hashText(taskRowContent), null);
    }
  }

  getFingerprint(baseDir: string, taskId: string): ContextFingerprint | undefined {
    const row = this.database
      .prepare('SELECT context_mtime AS mtimeMs, context_size AS size FROM nav_tasks WHERE base_dir = ? AND task_id = ?')
      .get(baseDir, taskId) as unknown as { mtimeMs: number | null; size: number | null } | undefined;
    if (!row || row.mtimeMs === null || row.size === null) {
      return undefined;
    }
    return { mtimeMs: row.mtimeMs, size: row.size };
  }

  /**
   * Brings the indexed messages of a task in line with the given rows: unchanged messages are kept, new and changed ones
   * are written, and messages no longer present are removed. A fingerprint of undefined keeps the stored one; null clears it.
   */
  replaceTask(info: IndexedTaskInfo, rows: IndexMessageRow[], fingerprint?: ContextFingerprint | null): ReplaceTaskResult {
    const desired = new Map<string, IndexMessageRow & { hash: string }>();
    for (const row of rows) {
      if (!row.content || row.messageId === SEARCH_TASK_ROW_MESSAGE_ID || desired.has(row.messageId)) {
        continue;
      }
      desired.set(row.messageId, { ...row, hash: hashText(row.content) });
    }

    return this.transaction((db) => {
      const existing = db
        .prepare('SELECT message_id AS messageId, content_hash AS hash FROM nav_messages WHERE base_dir = ? AND task_id = ? AND message_id <> ?')
        .all(info.baseDir, info.taskId, SEARCH_TASK_ROW_MESSAGE_ID) as unknown as Array<{ messageId: string; hash: string }>;
      const existingHashes = new Map(existing.map((row) => [row.messageId, row.hash]));

      let removed = 0;
      const remove = db.prepare('DELETE FROM nav_messages WHERE base_dir = ? AND task_id = ? AND message_id = ?');
      for (const [messageId, hash] of existingHashes) {
        if (desired.get(messageId)?.hash !== hash) {
          remove.run(info.baseDir, info.taskId, messageId);
          removed++;
        }
      }

      let inserted = 0;
      const insert = db.prepare(INSERT_MESSAGE_SQL);
      for (const row of desired.values()) {
        if (existingHashes.get(row.messageId) !== row.hash) {
          insert.run(info.baseDir, info.taskId, row.messageId, row.role, row.content, row.hash, toNullable(row.timestamp));
          inserted++;
        }
      }

      this.writeTaskInfo(db, info, fingerprint);
      return { inserted, removed };
    });
  }

  /** Updates the task's metadata and its name/topics row without touching its messages. */
  updateTaskInfo(info: IndexedTaskInfo): void {
    this.transaction((db) => this.writeTaskInfo(db, info));
  }

  deleteTask(baseDir: string, taskId: string): void {
    this.transaction((db) => {
      db.prepare('DELETE FROM nav_messages WHERE base_dir = ? AND task_id = ?').run(baseDir, taskId);
      db.prepare('DELETE FROM nav_vectors WHERE base_dir = ? AND task_id = ?').run(baseDir, taskId);
      db.prepare('DELETE FROM nav_tasks WHERE base_dir = ? AND task_id = ?').run(baseDir, taskId);
    });
    this.vectorCache = null;
  }

  clearFingerprints(): void {
    this.database.exec('UPDATE nav_tasks SET context_mtime = NULL, context_size = NULL');
  }

  listTasks(baseDir?: string): IndexedTaskInfo[] {
    const statement = this.database.prepare(`SELECT ${TASK_COLUMNS} FROM nav_tasks${baseDir === undefined ? '' : ' WHERE base_dir = ?'}`);
    const rows = (baseDir === undefined ? statement.all() : statement.all(baseDir)) as unknown as TaskRow[];
    return rows.map(toTaskInfo);
  }

  getTask(baseDir: string, taskId: string): IndexedTaskInfo | undefined {
    const row = this.database.prepare(`SELECT ${TASK_COLUMNS} FROM nav_tasks WHERE base_dir = ? AND task_id = ?`).get(baseDir, taskId) as unknown as
      | TaskRow
      | undefined;
    return row ? toTaskInfo(row) : undefined;
  }

  getUserMessages(baseDir: string, taskId: string): Array<{ messageId: string; content: string }> {
    return this.database
      .prepare("SELECT message_id AS messageId, content FROM nav_messages WHERE base_dir = ? AND task_id = ? AND role = 'user' ORDER BY id")
      .all(baseDir, taskId) as unknown as Array<{ messageId: string; content: string }>;
  }

  counts(): { tasks: number; messages: number; vectors: number } {
    const count = (sql: string, ...params: string[]): number => {
      const row = this.database.prepare(sql).get(...params) as unknown as { total: number } | undefined;
      return Number(row?.total ?? 0);
    };
    return {
      tasks: count('SELECT COUNT(*) AS total FROM nav_tasks'),
      messages: count('SELECT COUNT(*) AS total FROM nav_messages WHERE message_id <> ?', SEARCH_TASK_ROW_MESSAGE_ID),
      vectors: count('SELECT COUNT(*) AS total FROM nav_vectors'),
    };
  }

  keywordSearch(ftsQuery: string, limit: number): KeywordHit[] {
    const rows = this.database
      .prepare(
        `SELECT m.base_dir AS baseDir, m.task_id AS taskId, m.message_id AS messageId, m.role AS role, m.timestamp AS timestamp,
                snippet(nav_messages_fts, 0, char(2), char(3), '…', 18) AS snippet, bm25(nav_messages_fts) AS rank
         FROM nav_messages_fts JOIN nav_messages m ON m.id = nav_messages_fts.rowid
         WHERE nav_messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as Array<Omit<KeywordHit, 'timestamp'> & { timestamp: number | null }>;
    return rows.map((row) => ({ ...row, timestamp: row.timestamp ?? undefined }));
  }

  getVectorHashes(baseDir: string, taskId: string): Map<string, string> {
    const rows = this.database
      .prepare('SELECT slot, text_hash AS textHash FROM nav_vectors WHERE base_dir = ? AND task_id = ?')
      .all(baseDir, taskId) as unknown as Array<{ slot: string; textHash: string }>;
    return new Map(rows.map((row) => [row.slot, row.textHash]));
  }

  /** Upserts the given vectors and removes the task's vectors whose slot is not in keepSlots. */
  writeVectors(baseDir: string, taskId: string, writes: VectorWrite[], keepSlots: Set<string>): void {
    this.transaction((db) => {
      const existing = db.prepare('SELECT slot FROM nav_vectors WHERE base_dir = ? AND task_id = ?').all(baseDir, taskId) as unknown as Array<{ slot: string }>;
      const remove = db.prepare('DELETE FROM nav_vectors WHERE base_dir = ? AND task_id = ? AND slot = ?');
      for (const { slot } of existing) {
        if (!keepSlots.has(slot)) {
          remove.run(baseDir, taskId, slot);
        }
      }
      const upsert = db.prepare(
        `INSERT INTO nav_vectors (base_dir, task_id, slot, message_id, kind, text, text_hash, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (base_dir, task_id, slot) DO UPDATE SET
           message_id = excluded.message_id, kind = excluded.kind, text = excluded.text, text_hash = excluded.text_hash, vector = excluded.vector`,
      );
      for (const write of writes) {
        const bytes = new Uint8Array(write.vector.buffer, write.vector.byteOffset, write.vector.byteLength);
        upsert.run(baseDir, taskId, write.slot, write.messageId, write.kind, write.text, write.textHash, bytes);
      }
    });
    this.vectorCache = null;
  }

  /** Cosine similarity search over normalised vectors. */
  searchVectors(query: Float32Array, limit: number, minScore: number): VectorMatch[] {
    const cache = this.loadVectorCache();
    if (!cache || cache.dimension !== query.length) {
      return [];
    }

    const { entries, matrix, dimension } = cache;
    const scored: Array<{ index: number; score: number }> = [];
    for (let index = 0; index < entries.length; index++) {
      const offset = index * dimension;
      let score = 0;
      for (let d = 0; d < dimension; d++) {
        score += matrix[offset + d] * query[d];
      }
      if (score >= minScore) {
        scored.push({ index, score });
      }
    }

    scored.sort((first, second) => second.score - first.score);
    return scored.slice(0, limit).map(({ index, score }) => ({ ...entries[index], score }));
  }

  private loadVectorCache(): VectorCache | null {
    if (this.vectorCache) {
      return this.vectorCache;
    }

    const rows = this.database
      .prepare('SELECT base_dir AS baseDir, task_id AS taskId, message_id AS messageId, kind, text, vector FROM nav_vectors')
      .all() as unknown as Array<VectorCacheEntry & { vector: Uint8Array }>;
    if (rows.length === 0) {
      return null;
    }

    const dimension = rows[0].vector.byteLength / 4;
    const valid = rows.filter((row) => row.vector.byteLength === dimension * 4);
    const matrix = new Float32Array(valid.length * dimension);
    valid.forEach((row, index) => {
      matrix.set(new Float32Array(row.vector.slice().buffer), index * dimension);
    });

    this.vectorCache = {
      entries: valid.map((row) => ({ baseDir: row.baseDir, taskId: row.taskId, messageId: row.messageId, kind: row.kind, text: row.text })),
      matrix,
      dimension,
    };
    return this.vectorCache;
  }
}
