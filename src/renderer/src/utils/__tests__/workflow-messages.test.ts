import { describe, expect, it } from 'vitest';
import { GroupMessage, isWorkflowRunMessage, Message, ToolMessage, WorkflowLogData } from '@common/types';

import { composeMessagesWithWorkflowRuns, groupWorkflowLogsByRun } from '@/utils/workflow-messages';
import { groupMessagesByPromptContext } from '@/components/message/utils';
import type { WorkflowRunState } from '@/stores/taskStore';

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

const makeInvocation = (id: string, runId: string): Message => ({
  id,
  type: 'user',
  content: 'prompt',
  promptContext: {
    id,
    workflow: { runId, workflowId: 'dev-pipeline', workflowName: 'Dev Pipeline', kind: 'invocation' },
  },
  timestamp: 100,
});

const makeRun = (runId: string, logs: WorkflowLogData[]): WorkflowRunState => ({
  runId,
  workflowId: 'dev-pipeline',
  workflowName: 'Dev Pipeline',
  logs,
});

describe('composeMessagesWithWorkflowRuns', () => {
  it('inserts a run panel immediately after its invocation', () => {
    const invocation = makeInvocation('inv-1', 'run-1');
    const messages: Message[] = [invocation, { id: 'resp-1', type: 'response', content: 'done' }];
    const runs = [makeRun('run-1', [makeLog({ runId: 'run-1', sequence: 1, timestamp: 1000 })])];

    const result = composeMessagesWithWorkflowRuns(messages, runs);
    expect(result.map((m) => m.id)).toEqual(['inv-1', 'workflow-run-run-1', 'resp-1']);
    expect(isWorkflowRunMessage(result[1])).toBe(true);
  });

  it('anchors multiple runs to their own invocations in order', () => {
    const inv1 = makeInvocation('inv-1', 'run-1');
    const inv2 = makeInvocation('inv-2', 'run-2');
    const messages: Message[] = [inv1, inv2];
    const runs = [
      makeRun('run-1', [makeLog({ runId: 'run-1', sequence: 1, timestamp: 1000 })]),
      makeRun('run-2', [makeLog({ runId: 'run-2', sequence: 2, timestamp: 2000 })]),
    ];

    const result = composeMessagesWithWorkflowRuns(messages, runs);
    expect(result.map((m) => m.id)).toEqual(['inv-1', 'workflow-run-run-1', 'inv-2', 'workflow-run-run-2']);
  });

  it('places an orphan run by earliest-log timestamp', () => {
    const messages: Message[] = [
      { id: 'user-1', type: 'user', content: 'hi', timestamp: 100 },
      { id: 'resp-1', type: 'response', content: 'a', timestamp: 500 },
      { id: 'resp-2', type: 'response', content: 'b', timestamp: 900 },
    ];
    const runs = [makeRun('orphan-1', [makeLog({ runId: 'orphan-1', sequence: 1, timestamp: 600 })])];

    const result = composeMessagesWithWorkflowRuns(messages, runs);
    // Orphan's earliest log (600) is before resp-2 (900) but after resp-1 (500),
    // so it is inserted before resp-2.
    expect(result.map((m) => m.id)).toEqual(['user-1', 'resp-1', 'workflow-run-orphan-1', 'resp-2']);
  });

  it('appends an orphan at the end when no message has a later timestamp', () => {
    // Messages carry no timestamps, so no message is "after" the orphan's
    // earliest log timestamp and the panel is appended at the end.
    const messages: Message[] = [
      { id: 'user-1', type: 'user', content: 'hi' },
      { id: 'resp-1', type: 'response', content: 'a' },
    ];
    const runs = [makeRun('orphan-1', [makeLog({ runId: 'orphan-1', sequence: 1, timestamp: 100 })])];

    const result = composeMessagesWithWorkflowRuns(messages, runs);
    expect(result.map((m) => m.id)).toEqual(['user-1', 'resp-1', 'workflow-run-orphan-1']);
  });

  it('returns the identical array reference when runs is empty', () => {
    const messages: Message[] = [{ id: 'user-1', type: 'user', content: 'hi' }];
    expect(composeMessagesWithWorkflowRuns(messages, [])).toBe(messages);
  });

  it('marks only the final panel as the latest run', () => {
    const inv1 = makeInvocation('inv-1', 'run-1');
    const inv2 = makeInvocation('inv-2', 'run-2');
    const messages: Message[] = [inv1, inv2];
    const runs = [
      makeRun('run-1', [makeLog({ runId: 'run-1', sequence: 1, timestamp: 1000 })]),
      makeRun('run-2', [makeLog({ runId: 'run-2', sequence: 2, timestamp: 2000 })]),
    ];

    const result = composeMessagesWithWorkflowRuns(messages, runs);
    const panels = result.filter(isWorkflowRunMessage);
    expect(panels).toHaveLength(2);
    expect(panels[0].isLatestRun).toBeUndefined();
    expect(panels[1].isLatestRun).toBe(true);
  });
});

describe('groupWorkflowLogsByRun', () => {
  it('deduplicates duplicate log ids within a run', () => {
    const logs = [
      makeLog({ id: 'dup', runId: 'run-1', sequence: 1, timestamp: 100 }),
      makeLog({ id: 'dup', runId: 'run-1', sequence: 2, timestamp: 200 }),
      makeLog({ id: 'unique', runId: 'run-1', sequence: 3, timestamp: 300 }),
    ];

    const runs = groupWorkflowLogsByRun(logs);
    expect(runs).toHaveLength(1);
    expect(runs[0].logs.map((log) => log.id)).toEqual(['dup', 'unique']);
  });
});

describe('workflow-run panels and prompt-context grouping', () => {
  it('a run panel interleaved before subagent-group messages survives groupMessagesByPromptContext with the group intact', () => {
    const invocation = makeInvocation('inv-1', 'run-1');
    const groupId = 'group-1';
    const subagentTool: ToolMessage = {
      id: 'tool-1',
      type: 'tool',
      content: '',
      serverName: 'subagents',
      toolName: 'run_task',
      args: {},
      promptContext: { id: 'pc-1', group: { id: groupId, name: 'Subagent', finished: true } },
    };
    const subagentResponse: Message = {
      id: 'resp-1',
      type: 'response',
      content: 'result',
      promptContext: { id: 'pc-2', group: { id: groupId, name: 'Subagent', finished: true } },
    };

    const messages: Message[] = [invocation, subagentTool, subagentResponse];
    const runs = [makeRun('run-1', [makeLog({ runId: 'run-1', sequence: 1, timestamp: 1000 })])];

    const composed = composeMessagesWithWorkflowRuns(messages, runs);
    const grouped = groupMessagesByPromptContext(composed);

    // The run panel is inserted after the invocation, before the group messages.
    expect(grouped.map((m) => m.id)).toEqual(['inv-1', 'workflow-run-run-1', 'tool-1']);
    const group = grouped[2] as GroupMessage;
    expect(group.type).toBe('group');
    expect(group.group.id).toBe(groupId);
    expect(group.children.map((child) => child.id)).toEqual(['tool-1', 'resp-1']);
  });

  it('composed order is identical whether built from hydrated logs or incrementally appended ones', () => {
    const invocation = makeInvocation('inv-1', 'run-1');
    const messages: Message[] = [invocation, { id: 'resp-1', type: 'response', content: 'done' }];

    // Hydrated: all logs at once.
    const hydratedRuns = [
      makeRun('run-1', [
        makeLog({ runId: 'run-1', id: 'a', sequence: 1, timestamp: 100 }),
        makeLog({ runId: 'run-1', id: 'b', sequence: 2, timestamp: 200 }),
      ]),
    ];

    // Incremental: same logs appended one at a time.
    const incrementalRuns = [
      makeRun('run-1', [makeLog({ runId: 'run-1', id: 'a', sequence: 1, timestamp: 100 })]),
    ];
    incrementalRuns[0].logs.push(makeLog({ runId: 'run-1', id: 'b', sequence: 2, timestamp: 200 }));

    const hydrated = composeMessagesWithWorkflowRuns(messages, hydratedRuns);
    const incremental = composeMessagesWithWorkflowRuns(messages, incrementalRuns);

    expect(hydrated.map((m) => m.id)).toEqual(incremental.map((m) => m.id));
    const hydratedPanel = hydrated.find(isWorkflowRunMessage)!;
    const incrementalPanel = incremental.find(isWorkflowRunMessage)!;
    expect(hydratedPanel.logs.map((log) => log.id)).toEqual(incrementalPanel.logs.map((log) => log.id));
  });
});
