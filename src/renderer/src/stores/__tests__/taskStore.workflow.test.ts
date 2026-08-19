import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowLogData } from '@common/types';

import { appendWorkflowLog, clearWorkflowRuns, setWorkflowLogs, unloadTask, useTaskStore } from '@/stores/taskStore';

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

describe('taskStore workflow state', () => {
  beforeEach(() => {
    // Reset the store between tests.
    useTaskStore.setState({
      taskWorkflowRunsMap: new Map(),
      taskHasWorkflowHistoryMap: new Map(),
    });
  });

  it('setWorkflowLogs groups by run in first-seen order, sorts by sequence, and dedupes by id', () => {
    setWorkflowLogs('task-1', [
      makeLog({ id: 'b', runId: 'run-2', sequence: 2, timestamp: 200 }),
      makeLog({ id: 'a', runId: 'run-1', sequence: 1, timestamp: 100 }),
      makeLog({ id: 'a', runId: 'run-1', sequence: 3, timestamp: 300 }), // duplicate id
      makeLog({ id: 'c', runId: 'run-1', sequence: 4, timestamp: 400 }),
    ]);

    const runs = useTaskStore.getState().taskWorkflowRunsMap.get('task-1')!;
    // Sorted by sequence, run-1 is seen first, then run-2.
    expect(runs.map((run) => run.runId)).toEqual(['run-1', 'run-2']);
    // run-1 logs sorted by sequence and deduped by id.
    expect(runs[0].logs.map((log) => log.id)).toEqual(['a', 'c']);
  });

  it('appendWorkflowLog creates new runs at the end and inserts into existing runs in order', () => {
    appendWorkflowLog('task-1', makeLog({ id: 'a', runId: 'run-1', sequence: 1, timestamp: 100 }));
    appendWorkflowLog('task-1', makeLog({ id: 'b', runId: 'run-2', sequence: 1, timestamp: 100 }));
    appendWorkflowLog('task-1', makeLog({ id: 'c', runId: 'run-1', sequence: 2, timestamp: 200 }));

    const runs = useTaskStore.getState().taskWorkflowRunsMap.get('task-1')!;
    expect(runs.map((run) => run.runId)).toEqual(['run-1', 'run-2']);
    expect(runs[0].logs.map((log) => log.id)).toEqual(['a', 'c']);
  });

  it('clearWorkflowRuns no-ops when absent and clears when present', () => {
    clearWorkflowRuns('task-1');
    expect(useTaskStore.getState().taskWorkflowRunsMap.has('task-1')).toBe(false);

    appendWorkflowLog('task-1', makeLog({ id: 'a', runId: 'run-1', sequence: 1, timestamp: 100 }));
    expect(useTaskStore.getState().taskWorkflowRunsMap.has('task-1')).toBe(true);

    clearWorkflowRuns('task-1');
    expect(useTaskStore.getState().taskWorkflowRunsMap.has('task-1')).toBe(false);
  });

  it('unloadTask removes both workflow maps entries', () => {
    setWorkflowLogs('task-1', [makeLog({ id: 'a', runId: 'run-1', sequence: 1, timestamp: 100 })]);
    useTaskStore.getState().setHasWorkflowHistory('task-1', true);

    expect(useTaskStore.getState().taskWorkflowRunsMap.has('task-1')).toBe(true);
    expect(useTaskStore.getState().taskHasWorkflowHistoryMap.get('task-1')).toBe(true);

    unloadTask('task-1');

    expect(useTaskStore.getState().taskWorkflowRunsMap.has('task-1')).toBe(false);
    expect(useTaskStore.getState().taskHasWorkflowHistoryMap.has('task-1')).toBe(false);
  });
});
