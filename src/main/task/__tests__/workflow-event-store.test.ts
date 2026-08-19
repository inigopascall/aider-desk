import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkflowEventStore } from '../workflow-event-store';

import type { WorkflowLogData } from '@common/types';

const makeLog = (overrides: Partial<WorkflowLogData> = {}): WorkflowLogData => ({
  id: 'log-1',
  baseDir: '/project',
  taskId: 'task-1',
  runId: 'run-1',
  workflowId: 'dev-pipeline',
  workflowName: 'Dev Pipeline',
  level: 'info',
  message: 'hello',
  timestamp: 1000,
  sequence: 1,
  ...overrides,
});

describe('WorkflowEventStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-event-store-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('append -> load roundtrip preserves order and fields', async () => {
    const store = new WorkflowEventStore(tempDir, 'task-1');
    await store.ready();

    const first = makeLog({ id: 'a', sequence: 1, timestamp: 100 });
    const second = makeLog({ id: 'b', sequence: 2, timestamp: 200, level: 'warning', message: 'warn' });
    await store.append(first);
    await store.append(second);

    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(first);
    expect(loaded[1]).toEqual(second);
  });

  it('ready() before allocateSequence() continues from the persisted max sequence after re-instantiation', async () => {
    const store = new WorkflowEventStore(tempDir, 'task-1');
    await store.ready();
    await store.append(makeLog({ id: 'a', sequence: 1, timestamp: 100 }));
    await store.append(makeLog({ id: 'b', sequence: 2, timestamp: 200 }));

    // Re-instantiate against the same directory; ready() must resume from max sequence.
    const reloaded = new WorkflowEventStore(tempDir, 'task-1');
    await reloaded.ready();
    expect(reloaded.allocateSequence()).toBe(3);
  });

  it('skips malformed JSONL lines and retains valid ones', async () => {
    const store = new WorkflowEventStore(tempDir, 'task-1');
    await store.ready();
    await store.append(makeLog({ id: 'a', sequence: 1, timestamp: 100 }));

    const filePath = store.getFilePath();
    await fs.appendFile(filePath, 'not-json\n{"id": 123}\n', 'utf8');

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('a');
  });

  it('exists() transitions from false to true after appending', async () => {
    const store = new WorkflowEventStore(tempDir, 'task-1');
    expect(await store.exists()).toBe(false);

    await store.ready();
    await store.append(makeLog({ id: 'a', sequence: 1, timestamp: 100 }));

    expect(await store.exists()).toBe(true);
  });

  it('clear() resets the store', async () => {
    const store = new WorkflowEventStore(tempDir, 'task-1');
    await store.ready();
    await store.append(makeLog({ id: 'a', sequence: 1, timestamp: 100 }));

    await store.clear();

    expect(await store.exists()).toBe(false);
    expect(await store.load()).toEqual([]);
  });

  it('copyFrom honours untilTimestamp', async () => {
    const source = new WorkflowEventStore(tempDir, 'source-task');
    await source.ready();
    await source.append(makeLog({ id: 'a', sequence: 1, timestamp: 100 }));
    await source.append(makeLog({ id: 'b', sequence: 2, timestamp: 200 }));
    await source.append(makeLog({ id: 'c', sequence: 3, timestamp: 300 }));

    const target = new WorkflowEventStore(tempDir, 'target-task');
    await target.ready();
    await target.copyFrom(source, { untilTimestamp: 200 });

    const loaded = await target.load();
    expect(loaded.map((log) => log.id)).toEqual(['a', 'b']);
  });
});
