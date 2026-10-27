import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultTaskState, TASK_NAVIGATION_METADATA_KEYS, TaskData } from '@common/types';

import { TopicMapModal } from '../TopicMapModal';

import { render } from '@/__tests__/render';
import { useApi } from '@/contexts/ApiContext';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskBookmarks } from '@/stores/bookmarkStore';
import { useTaskMessages } from '@/stores/taskStore';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';

const api = {
  getTaskTopicEstimates: vi.fn(),
  previewTopicCompaction: vi.fn(),
  compactTopic: vi.fn(),
};

vi.mock('@/contexts/ApiContext', () => ({ useApi: vi.fn() }));
vi.mock('@/stores/taskStore', () => ({ useTaskMessages: vi.fn() }));
vi.mock('@/stores/bookmarkStore', () => ({ useTaskBookmarks: vi.fn() }));
vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

const baseDir = '/projects/alpha';
const taskId = 'task';
const task = {
  id: taskId,
  baseDir,
  name: 'Compaction task',
  state: DefaultTaskState.ReadyForReview,
  createdAt: '2026-10-24T08:00:00.000Z',
  updatedAt: '2026-10-24T09:00:00.000Z',
  aiderTotalCost: 0,
  agentTotalCost: 0,
  mainModel: 'test/model',
  metadata: {
    [TASK_NAVIGATION_METADATA_KEYS.taskSummary]: {
      title: 'Summary',
      generatedAt: '2026-10-24T10:00:00.000Z',
      topics: [
        { summary: 'A', messageIds: ['u1', 'a1'] },
        { summary: 'B', messageIds: ['u2', 'a2'] },
        { summary: 'C', messageIds: ['u3', 'a3'] },
      ],
    },
  },
} as TaskData;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const estimates = {
  topics: [
    { firstMessageId: 'u1', tokens: 22000, messageCount: 2, sections: [] },
    { firstMessageId: 'u2', tokens: 16000, messageCount: 2, sections: [] },
    { firstMessageId: 'u3', tokens: 1000, messageCount: 2, sections: [] },
  ],
};

const preview = {
  compactable: true,
  sourceTokens: 16000,
  sourceCharacters: 6000,
  messageCount: 2,
  firstMessageId: 'u2',
  endBeforeMessageId: 'u3',
  targetCharacters: { 1: 1000, 2: 2000, 3: 3000, 4: 4000, 5: 5000 },
};

describe('TopicMapModal compaction concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useApi).mockReturnValue(api as never);
    vi.mocked(useTaskMessages).mockReturnValue([]);
    vi.mocked(useTaskBookmarks).mockReturnValue({});
    api.getTaskTopicEstimates.mockResolvedValue(estimates);
    api.previewTopicCompaction.mockImplementation((_baseDir, _taskId, target) =>
      Promise.resolve({
        ...preview,
        firstMessageId: target.firstMessageId,
        endBeforeMessageId: target.firstMessageId === 'u1' ? 'u2' : 'u3',
      }),
    );
    api.compactTopic.mockReset();
    useSettingsStore.setState({ settings: null, theme: null, font: null, fontSize: null, readonlyExtensionUi: null });
    useTaskNavigationStore.setState({ topicMapOpen: true, pendingCompactions: {}, topicMapViews: {} });
  });
  it('keeps independent topic compactions visible until each request resolves', async () => {
    const requests: Array<ReturnType<typeof deferred<void>>> = [];
    api.compactTopic.mockImplementation(() => {
      const request = deferred<void>();
      requests.push(request);
      return request.promise;
    });
    const onScrollToMessage = vi.fn();

    render(<TopicMapModal task={task} onScrollToMessage={onScrollToMessage} />);
    await waitFor(() => expect(api.getTaskTopicEstimates).toHaveBeenCalled());

    const topicRow = (name: string) => screen.getByText(name).closest<HTMLElement>('[data-index]')!;
    fireEvent.click(within(topicRow('A')).getByRole('button', { name: 'taskNavigation.compaction.compact' }));
    await waitFor(() => expect(api.previewTopicCompaction).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'taskNavigation.compaction.panel.confirm' }));

    expect(screen.queryByTestId('topic-compaction-panel')).toBeNull();
    expect(useTaskNavigationStore.getState().topicMapOpen).toBe(true);
    expect(screen.getByTestId('compacting-0-topic')).toBeInTheDocument();
    expect(within(topicRow('B')).getByRole('button', { name: 'taskNavigation.compaction.compact' })).toBeEnabled();

    fireEvent.click(within(topicRow('B')).getByRole('button', { name: 'taskNavigation.compaction.compact' }));
    await waitFor(() => expect(api.previewTopicCompaction).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'taskNavigation.compaction.panel.confirm' }));

    expect(requests).toHaveLength(2);
    expect(screen.getByTestId('compacting-0-topic')).toBeInTheDocument();
    expect(screen.getByTestId('compacting-1-topic')).toBeInTheDocument();

    await act(async () => requests[0].resolve());
    await waitFor(() => expect(screen.queryByTestId('compacting-0-topic')).toBeNull());
    expect(screen.getByTestId('compacting-1-topic')).toBeInTheDocument();

    await act(async () => requests[1].resolve());
    await waitFor(() => expect(screen.queryByTestId('compacting-1-topic')).toBeNull());
    expect(onScrollToMessage).not.toHaveBeenCalled();
    expect(useTaskNavigationStore.getState().topicMapOpen).toBe(true);
  });
});
