import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMessage, DefaultTaskState, TaskData, TaskSummary, TaskTopic, getCompactionArchives, getTaskSummary } from '@common/types';

import { notifyTaskNavigationContextReplace } from '../hooks';
import { SearchIndex } from '../search-index';
import { SUMMARY_SYSTEM_PROMPT } from '../summary-model';
import { TaskNavigationGenerate, TaskNavigationManager, TaskNavigationManagerDependencies } from '../task-navigation-manager';
import { COMPACTION_SYSTEM_PROMPT } from '../topic-compaction';
import { getTopicCompactionsDir, listCompactionSidecars } from '../topic-compaction-store';

vi.mock('@/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const TASK_ID = 'task-1';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const user = (id: string, text = `Question ${id}`): ContextMessage => ({ id, role: 'user', content: text }) as ContextMessage;

const assistant = (id: string, text = `Answer ${id}`, callIds: string[] = []): ContextMessage =>
  ({
    id,
    role: 'assistant',
    content: [
      { type: 'text', text },
      ...callIds.map((toolCallId) => ({ type: 'tool-call', toolCallId, toolName: 'power---bash', input: { command: `run ${toolCallId}` } })),
    ],
  }) as ContextMessage;

const toolResult = (id: string, toolCallId: string): ContextMessage =>
  ({
    id,
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName: 'power---bash', output: { type: 'text', value: `output of ${toolCallId}` } }],
  }) as ContextMessage;

const conversation = (): ContextMessage[] => [
  user('u1'),
  assistant('a1', 'Answer a1', ['c1']),
  toolResult('t1', 'c1'),
  user('u2'),
  assistant('a2'),
  user('u3'),
  assistant('a3'),
  user('u4', 'Configure the zebra cache'),
  assistant('a4', 'The zebra cache is configured'),
  user('u5'),
  assistant('a5'),
];

const topicMap = (): TaskTopic[] => [
  {
    summary: 'Topic A',
    messageIds: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'],
    sectioned: true,
    sections: [
      { summary: 'First part', startMessageId: 'u1' },
      { summary: 'Second part', startMessageId: 'u2' },
      { summary: 'Third part', startMessageId: 'u3' },
    ],
  },
  { summary: 'Topic B', messageIds: ['u4', 'a4'], sectioned: true },
  { summary: 'Topic C', messageIds: ['u5', 'a5'] },
];

const topicB = { topicIndex: 1, firstMessageId: 'u4' };

/** Stands in for a Task: an in-memory conversation whose replacements are reported like ContextManager.setContextMessages does. */
class FakeTask {
  task: TaskData;
  messages: ContextMessage[];

  constructor(baseDir: string) {
    const summary: TaskSummary = { title: 'Cache work', topics: topicMap(), generatedAt: '2026-10-24T09:00:00.000Z', model: 'test/model' };
    this.task = {
      id: TASK_ID,
      baseDir,
      name: 'Cache work',
      state: DefaultTaskState.ReadyForReview,
      createdAt: '2026-10-24T08:00:00.000Z',
      metadata: { taskNumber: 1, nameLocked: true, taskSummary: summary },
    } as unknown as TaskData;
    this.messages = conversation();
  }

  get topics(): TaskTopic[] {
    return getTaskSummary(this.task)?.topics ?? [];
  }

  async getContextMessages(): Promise<ContextMessage[]> {
    return clone(this.messages);
  }

  async saveTask(updates: Partial<TaskData>): Promise<TaskData> {
    Object.assign(this.task, clone(updates));
    return clone(this.task);
  }

  async replaceContextMessages(messages: ContextMessage[]): Promise<void> {
    this.setContextMessages(messages);
  }

  setContextMessages(messages: ContextMessage[]): void {
    notifyTaskNavigationContextReplace(this.task.baseDir, this.task.id, this.messages, messages);
    this.messages = clone(messages);
  }

  async getTaskAgentProfile(): Promise<null> {
    return null;
  }
}

describe('TaskNavigationManager topic compaction', () => {
  let baseDir: string;
  let task: FakeTask;
  let manager: TaskNavigationManager | undefined;

  const start = (generate: TaskNavigationGenerate): TaskNavigationManager => {
    const project = {
      baseDir,
      getTask: (id: string) => (id === TASK_ID ? task : null),
      getTasks: async () => [task.task],
    };
    const settings = { taskNavigation: { summaryModel: 'test/model', conceptSearchEnabled: false } };
    manager = new TaskNavigationManager({
      store: { getSettings: () => settings, getOpenProjects: () => [], getRecentProjects: () => [] },
      projectManager: { getProjects: () => [project] },
      modelManager: {},
      searchIndex: new SearchIndex(':memory:'),
      generate,
      archiveMetadataDelayMs: 0,
    } as unknown as TaskNavigationManagerDependencies);
    manager.init();
    return manager;
  };

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-nav-manager-'));
    task = new FakeTask(baseDir);
    manager = undefined;
  });

  afterEach(async () => {
    manager?.dispose();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('compacts a topic and undoes it, restoring the conversation exactly and removing the sidecar', async () => {
    const generate = vi.fn<TaskNavigationGenerate>(async () => 'Recap of the cache work');
    const navigation = start(generate);

    expect(await navigation.previewTopicCompaction(baseDir, TASK_ID, topicB)).toMatchObject({
      compactable: true,
      firstMessageId: 'u4',
      endBeforeMessageId: 'u5',
      messageCount: 2,
    });

    const saved = await navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 2, instructions: 'Mention the cache.' });
    expect(generate).toHaveBeenCalledWith('test/model', baseDir, TASK_ID, COMPACTION_SYSTEM_PROMPT, expect.stringContaining('Mention the cache.'), 300_000);
    const info = getTaskSummary(saved)!.topics[1].compaction!;
    expect(info).toMatchObject({ level: 2, messageCount: 2, model: 'test/model', summaryCharacters: 'Recap of the cache work'.length });
    expect(task.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      't1',
      'u2',
      'a2',
      'u3',
      'a3',
      info.promptMessageId,
      info.summaryMessageId,
      'u5',
      'a5',
    ]);

    const sidecars = await listCompactionSidecars(baseDir, TASK_ID);
    expect(sidecars.map((sidecar) => sidecar.id)).toEqual([info.id]);
    expect(sidecars[0].originalMessages).toEqual(conversation().slice(7, 9));
    expect(sidecars[0].instructions).toBe('Mention the cache.');

    const undone = await navigation.undoTopicCompaction(baseDir, TASK_ID, info.id);
    expect(task.messages).toEqual(conversation());
    expect(getTaskSummary(undone)!.topics).toEqual(topicMap());
    expect(await listCompactionSidecars(baseDir, TASK_ID)).toEqual([]);
  });

  it('refuses to compact a running task, also when it starts running while the recap is written', async () => {
    const generate = vi.fn<TaskNavigationGenerate>(async () => {
      task.task.state = DefaultTaskState.InProgress;
      return 'Recap';
    });
    const navigation = start(generate);

    await expect(navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 })).rejects.toThrow(/^running: /);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(task.messages).toEqual(conversation());
    expect(await listCompactionSidecars(baseDir, TASK_ID)).toEqual([]);

    expect((await navigation.previewTopicCompaction(baseDir, TASK_ID, topicB)).reason).toBe('running');
    await expect(navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 })).rejects.toThrow(/^running: /);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty recap', async () => '   '],
    [
      'a model error',
      async () => {
        throw new Error('Model unavailable');
      },
    ],
  ])('leaves everything unchanged after %s', async (_name, implementation) => {
    const navigation = start(vi.fn<TaskNavigationGenerate>(implementation));

    await expect(navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 })).rejects.toThrow();
    expect(task.messages).toEqual(conversation());
    expect(task.topics).toEqual(topicMap());
    expect(await listCompactionSidecars(baseDir, TASK_ID)).toEqual([]);
  });

  it('aborts when the stretch changed while the recap was written', async () => {
    const navigation = start(
      vi.fn<TaskNavigationGenerate>(async () => {
        const call = {
          id: 'x1',
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c7', toolName: 'power---bash', input: { command: 'ls' } }],
        } as ContextMessage;
        task.messages.splice(8, 0, call, toolResult('x2', 'c7'));
        return 'Recap';
      }),
    );

    await expect(navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 })).rejects.toThrow(/^not-found: /);
    expect(task.messages.map((message) => message.id)).toEqual(['u1', 'a1', 't1', 'u2', 'a2', 'u3', 'a3', 'u4', 'x1', 'x2', 'a4', 'u5', 'a5']);
    expect(task.topics).toEqual(topicMap());
    expect(await listCompactionSidecars(baseDir, TASK_ID)).toEqual([]);
  });

  it('archives the conversation when a built-in compaction removes a recap, and restoring the archive makes undo work again', async () => {
    const navigation = start(vi.fn<TaskNavigationGenerate>(async () => 'Recap of the cache work'));
    const saved = await navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 });
    const info = getTaskSummary(saved)!.topics[1].compaction!;
    const compacted = clone(task.messages);

    // Like /compact: keeps the first prompt, adds a summary, then clears the task metadata
    task.setContextMessages([compacted[0], user('s1', 'Summary of the conversation')]);
    task.task.metadata = undefined;
    // Numbering then gives the task a new number
    task.task.metadata = { taskNumber: 7 };

    await vi.waitFor(() => expect(getCompactionArchives(task.task)).toHaveLength(1));
    const [archive] = getCompactionArchives(task.task);
    expect(task.task.metadata).toMatchObject({ taskNumber: 1, nameLocked: true });
    expect(archive.reason).toBe('built-in-compaction');
    expect(archive.id).toMatch(/^archive-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z/);
    expect(task.topics[1].compaction).toEqual({ ...info, lost: true });
    expect(await fs.readdir(getTopicCompactionsDir(baseDir, TASK_ID))).toContain(`${archive.id}.json`);

    const restored = await navigation.restoreCompactionArchive(baseDir, TASK_ID, archive.id);
    expect(task.messages).toEqual(compacted);
    expect(getTaskSummary(restored)!.topics[1].compaction).toEqual(info);
    expect(getCompactionArchives(restored).map((item) => item.reason)).toEqual(['built-in-compaction', 'before-restore']);

    await navigation.undoTopicCompaction(baseDir, TASK_ID, info.id);
    expect(task.messages).toEqual(conversation());
    expect(task.topics).toEqual(topicMap());
  });

  it('does not archive a smart-compaction-like replacement that keeps every id', async () => {
    const navigation = start(vi.fn<TaskNavigationGenerate>(async () => 'Recap of the cache work'));
    await navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 });

    task.setContextMessages(task.messages.map((message) => (message.role === 'tool' ? { ...message, content: [] } : message)) as ContextMessage[]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getCompactionArchives(task.task)).toEqual([]);
    expect((await fs.readdir(getTopicCompactionsDir(baseDir, TASK_ID))).filter((name) => name.startsWith('archive-'))).toEqual([]);
  });

  it('finds the original messages of a compaction and points the hit at the recap', async () => {
    const navigation = start(vi.fn<TaskNavigationGenerate>(async () => 'Recap of the cache work'));
    const saved = await navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 });
    const info = getTaskSummary(saved)!.topics[1].compaction!;

    const compactedSearch = await navigation.search('zebra');
    expect(compactedSearch.results).toHaveLength(1);
    expect(compactedSearch.results[0].hits.map((hit) => hit.messageId)).toEqual([info.summaryMessageId]);

    await navigation.undoTopicCompaction(baseDir, TASK_ID, info.id);
    const restoredSearch = await navigation.search('zebra');
    expect(restoredSearch.results[0].hits.map((hit) => hit.messageId).sort()).toEqual(['a4', 'u4']);
  });

  it('keeps the topics up to the last compacted one when the topic map is rebuilt', async () => {
    const generate = vi.fn<TaskNavigationGenerate>(async (_modelId, _projectDir, _sessionId, systemPrompt) =>
      systemPrompt === SUMMARY_SYSTEM_PROMPT
        ? JSON.stringify({
            title: 'Rebuilt',
            topics: [{ key: 'T3', summary: 'Rebuilt last topic' }],
            assignments: [
              { ref: 'm1', topic: 'T3' },
              { ref: 'm2', topic: 'T3' },
            ],
          })
        : 'Recap of the cache work',
    );
    const navigation = start(generate);
    const saved = await navigation.compactTopic(baseDir, TASK_ID, topicB, { level: 3 });
    const compactedTopics = getTaskSummary(saved)!.topics;

    const rebuilt = await navigation.regenerateTaskSummary(baseDir, TASK_ID);
    expect(getTaskSummary(rebuilt!)!.topics).toEqual([compactedTopics[0], compactedTopics[1], { summary: 'Rebuilt last topic', messageIds: ['u5', 'a5'] }]);

    const summaryPrompt = generate.mock.calls.find((call) => call[3] === SUMMARY_SYSTEM_PROMPT)![4];
    expect(summaryPrompt).toContain('[m1] USER: Question u5');
    expect(summaryPrompt).not.toContain('zebra');
  });
});
