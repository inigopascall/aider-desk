import { isWorkflowRunMessage, Message, WorkflowLogData, WorkflowRunMessage } from '@common/types';

import type { WorkflowRunState } from '@/stores/taskStore';

/**
 * Groups a flat list of workflow log events into per-run timelines.
 * Logs are sorted by sequence (then timestamp, then id) and folded into
 * a Map keyed by runId, preserving first-seen run order. Duplicate log ids
 * within a run are skipped.
 */
export const groupWorkflowLogsByRun = (logs: WorkflowLogData[]): WorkflowRunState[] => {
  const sorted = [...logs].sort((a, b) => a.sequence - b.sequence || a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const runs = new Map<string, WorkflowRunState>();
  for (const log of sorted) {
    let run = runs.get(log.runId);
    if (!run) {
      run = { runId: log.runId, workflowId: log.workflowId, workflowName: log.workflowName, logs: [] };
      runs.set(log.runId, run);
    }
    if (!run.logs.some((l) => l.id === log.id)) {
      run.logs.push(log);
    }
  }
  return [...runs.values()];
};

/**
 * Composes the conversation message array with collapsible workflow run panels.
 * Each run's panel is inserted immediately after its invocation message (the
 * first message carrying a matching `promptContext.workflow.runId` with kind
 * 'invocation'). Runs with no anchor are treated as orphans and placed by
 * earliest log timestamp. The conversation order is never otherwise modified.
 */
export const composeMessagesWithWorkflowRuns = (messages: Message[], runs: WorkflowRunState[]): Message[] => {
  if (runs.length === 0) {
    return messages;
  }

  // Map each invocation message id to the runs anchored to it.
  const anchored = new Map<string, WorkflowRunState[]>();
  const orphans: WorkflowRunState[] = [];
  for (const run of runs) {
    const anchor = messages.find((m) => m.promptContext?.workflow?.kind === 'invocation' && m.promptContext.workflow.runId === run.runId);
    if (anchor) {
      const list = anchored.get(anchor.id) || [];
      list.push(run);
      anchored.set(anchor.id, list);
    } else {
      orphans.push(run);
    }
  }

  const result: Message[] = [];
  const insertedIds = new Set<string>();
  for (const message of messages) {
    result.push(message);
    const runList = anchored.get(message.id);
    if (runList) {
      for (const run of runList) {
        const panel = buildWorkflowRunMessage(run);
        if (!insertedIds.has(panel.id)) {
          result.push(panel);
          insertedIds.add(panel.id);
        }
      }
    }
  }

  // Insert orphans before the first result message whose timestamp is greater
  // than the run's earliest log timestamp; otherwise append at the end.
  for (const run of orphans) {
    const panel = buildWorkflowRunMessage(run);
    if (insertedIds.has(panel.id)) {
      continue;
    }
    const earliest = run.logs[0]?.timestamp;
    let insertIndex = result.length;
    if (earliest !== undefined) {
      const idx = result.findIndex((m) => (m.timestamp ?? 0) > earliest);
      if (idx !== -1) {
        insertIndex = idx;
      }
    }
    result.splice(insertIndex, 0, panel);
    insertedIds.add(panel.id);
  }

  // Mark the final workflow-run panel as the latest run.
  for (let i = result.length - 1; i >= 0; i--) {
    const message = result[i];
    if (isWorkflowRunMessage(message)) {
      const latestRun: WorkflowRunMessage = { ...message, isLatestRun: true };
      result[i] = latestRun;
      break;
    }
  }

  return result;
};

const buildWorkflowRunMessage = (run: WorkflowRunState): WorkflowRunMessage => ({
  id: `workflow-run-${run.runId}`,
  type: 'workflow-run',
  content: '',
  runId: run.runId,
  workflowId: run.workflowId,
  workflowName: run.workflowName,
  logs: run.logs,
  timestamp: run.logs[0]?.timestamp,
});
