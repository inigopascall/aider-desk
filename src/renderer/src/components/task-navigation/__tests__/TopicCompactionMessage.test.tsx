import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultTaskState, ResponseMessage, TASK_NAVIGATION_METADATA_KEYS, TaskData, TaskSummary, TopicCompactionInfo } from '@common/types';

import { renderTopicCompactionMessage } from '../TopicCompactionMessage';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { useApi } from '@/contexts/ApiContext';
import { useProjectStore } from '@/stores/projectStore';

vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(),
}));

const BASE_DIR = '/project';
const TASK_ID = 'task-1';

const record: TopicCompactionInfo = {
  id: 'abc',
  level: 2,
  compactedAt: '2026-10-24T10:00:00.000Z',
  summaryMessageId: 'topic-compaction-abc',
  promptMessageId: 'topic-compaction-abc-prompt',
  messageCount: 6,
  sourceCharacters: 3000,
  summaryCharacters: 400,
};

const recapMessage: ResponseMessage = { id: 'topic-compaction-abc', type: 'response', content: 'The recap of the topic', finished: true };

const setTask = (state: string) => {
  const summary: TaskSummary = {
    title: 'Task',
    generatedAt: '2026-10-24T10:00:00.000Z',
    topics: [
      { summary: 'Compacted topic', messageIds: ['a1', 'a2'], compaction: record },
      { summary: 'Current topic', messageIds: ['b1'] },
    ],
  };
  const task = {
    id: TASK_ID,
    baseDir: BASE_DIR,
    name: 'Task',
    state,
    metadata: { [TASK_NAVIGATION_METADATA_KEYS.taskSummary]: summary },
  } as unknown as TaskData;
  useProjectStore.setState({ projectTasksMap: new Map([[BASE_DIR, [task]]]) });
};

const renderMessage = (message: ResponseMessage) =>
  render(<>{renderTopicCompactionMessage({ baseDir: BASE_DIR, taskId: TASK_ID, message, allFiles: [], renderMarkdown: false, hideMessageBar: true })}</>);

describe('TopicCompactionMessage', () => {
  let mockApi: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    mockApi = createMockApi();
    vi.mocked(useApi).mockReturnValue(mockApi);
  });

  it('returns null for an ordinary response', () => {
    expect(
      renderTopicCompactionMessage({ baseDir: BASE_DIR, taskId: TASK_ID, message: { ...recapMessage, id: 'm1' }, allFiles: [], renderMarkdown: false }),
    ).toBeNull();
  });

  it('shows the compacting placeholder', () => {
    renderMessage({ id: 'task-navigation-compacting-3', type: 'response', content: '', finished: true });

    expect(screen.getByText('taskNavigation.compaction.compacting')).toBeInTheDocument();
  });

  it('shows the recap with its badge, and Undo calls undoTopicCompaction with the compaction id', async () => {
    setTask(DefaultTaskState.Todo);
    renderMessage(recapMessage);

    expect(screen.getByText('The recap of the topic')).toBeInTheDocument();
    expect(screen.getByText('taskNavigation.compaction.badge')).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: 'taskNavigation.compaction.undo' });
    expect(undo).not.toBeDisabled();
    fireEvent.click(undo);

    await waitFor(() => expect(mockApi.undoTopicCompaction).toHaveBeenCalledWith(BASE_DIR, TASK_ID, 'abc'));
  });

  it('disables Undo while the task is running', () => {
    setTask(DefaultTaskState.InProgress);
    renderMessage(recapMessage);

    const undo = screen.getByRole('button', { name: 'taskNavigation.compaction.undo' });
    expect(undo).toBeDisabled();
    fireEvent.click(undo);
    expect(mockApi.undoTopicCompaction).not.toHaveBeenCalled();
  });
});
