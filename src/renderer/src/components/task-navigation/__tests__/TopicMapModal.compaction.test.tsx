import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultTaskState, getTaskSummary, TASK_NAVIGATION_METADATA_KEYS, TaskData } from '@common/types';
import en from '@common/locales/en.json';

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
  undoTopicCompaction: vi.fn(),
};

vi.mock('@/contexts/ApiContext', () => ({ useApi: vi.fn() }));
vi.mock('@/stores/taskStore', () => ({ useTaskMessages: vi.fn() }));
vi.mock('@/stores/bookmarkStore', () => ({ useTaskBookmarks: vi.fn() }));
vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; tokens?: string }) => {
      if (key === 'taskNavigation.topicMap.messageTokens') {
        return `${options?.count ?? 0} message${options?.count === 1 ? '' : 's'}, ${options?.tokens ?? ''}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

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
  it('keeps the English message-token variants aligned with the translation JSON', () => {
    expect(en.taskNavigation.topicMap.messageTokens_one).toBe('{{count}} message, {{tokens}}');
    expect(en.taskNavigation.topicMap.messageTokens_other).toBe('{{count}} messages, {{tokens}}');
  });

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
    api.undoTopicCompaction.mockReset();
    useSettingsStore.setState({ settings: null, theme: null, font: null, fontSize: null, readonlyExtensionUi: null });
    useTaskNavigationStore.setState({ topicMapOpen: true, pendingCompactions: {}, topicMapViews: {} });
  });
  it('uses one conversation-token denominator for topics and sections, including collapsed topics', async () => {
    const sectionTask = {
      ...task,
      metadata: {
        ...task.metadata,
        [TASK_NAVIGATION_METADATA_KEYS.taskSummary]: {
          ...(getTaskSummary(task) ?? { title: 'Summary', generatedAt: '2026-10-24T10:00:00.000Z', topics: [] }),
          topics: [
            { summary: 'A', messageIds: ['u1', 'a1'], sections: [{ summary: 'A section', startMessageId: 'u1', messageIds: ['u1', 'a1'] }] },
            { summary: 'B', messageIds: ['u2', 'a2'] },
            { summary: 'C', messageIds: ['u3', 'a3'] },
          ],
        },
      },
    } as TaskData;
    api.getTaskTopicEstimates.mockResolvedValue({
      topics: [
        { firstMessageId: 'u1', tokens: 400, messageCount: 2, sections: [{ firstMessageId: 'u1', tokens: 100 }] },
        { firstMessageId: 'u2', tokens: 200, messageCount: 2, sections: [] },
        { firstMessageId: 'u3', tokens: 0, messageCount: 2, sections: [] },
      ],
    });

    render(<TopicMapModal task={sectionTask} onScrollToMessage={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('topic-token-bar')[0]).toHaveAttribute('data-token-count', '400'));
    const fill = (element: HTMLElement) => Number(element.getAttribute('data-token-bar-fill'));
    const topicBars = screen.getAllByTestId('topic-token-bar');
    const sectionBars = screen.getAllByTestId('section-token-bar');
    expect(topicBars[0]).toHaveAttribute('data-token-layout', 'intrinsic');
    expect(sectionBars[0]).toHaveAttribute('data-token-layout', 'intrinsic');
    expect(fill(topicBars[0])).toBe(100);
    expect(fill(sectionBars[0])).toBe(25);
    expect(fill(topicBars[1])).toBe(50);
    expect(fill(topicBars[2])).toBe(0);
    expect(topicBars[0]).toHaveStyle({ width: 'calc(max(2.2rem, 2em) * 1)' });
    expect(sectionBars[0]).toHaveStyle({ width: 'calc(max(2.2rem, 2em) * 0.25)' });
    expect(topicBars[1]).toHaveStyle({ width: 'calc(max(2.2rem, 2em) * 0.5)' });
    expect(topicBars[2]).toHaveStyle({ width: 'calc(max(2.2rem, 2em) * 0)' });
    expect(topicBars[0]).toHaveAttribute('data-token-count', '400');
    expect(screen.queryByText('[100]')).toBeNull();
    const sectionRow = screen.getByText('A section').parentElement!;
    expect(within(sectionRow).getByText('100')).toBeInTheDocument();

    fireEvent.click(screen.getByText('A').closest('[data-index]')!);
    expect(fill(screen.getAllByTestId('topic-token-bar')[1])).toBe(50);
  });

  it('refetches estimates when messages change and excludes unknown or mismatched estimates', async () => {
    const messages = { current: [] as never[] };
    vi.mocked(useTaskMessages).mockImplementation(() => messages.current);
    api.getTaskTopicEstimates
      .mockResolvedValueOnce({
        topics: [
          { firstMessageId: 'u1', tokens: 400, messageCount: 2, sections: [] },
          { firstMessageId: 'wrong', tokens: 900, messageCount: 2, sections: [] },
          { firstMessageId: 'u3', tokens: null, messageCount: 2, sections: [] },
        ],
      })
      .mockResolvedValueOnce({
        topics: [
          { firstMessageId: 'u1', tokens: 100, messageCount: 2, sections: [] },
          { firstMessageId: 'u2', tokens: 200, messageCount: 2, sections: [] },
          { firstMessageId: 'u3', tokens: null, messageCount: 2, sections: [] },
        ],
      });
    const view = render(<TopicMapModal task={task} onScrollToMessage={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('topic-token-bar')[0]).toHaveAttribute('data-token-count', '400'));
    expect(screen.getAllByTestId('topic-token-bar')[0]).toHaveStyle({ width: 'calc(max(2.2rem, 2em) * 1)' });
    expect(screen.getAllByTestId('topic-token-bar')[1]).toHaveStyle({ width: 'calc(max(2.2rem, 2em) * 0)' });
    expect(screen.getAllByTestId('topic-token-bar')[2]).toHaveAttribute('data-token-bar-fill', '0');
    expect(screen.getAllByTestId('topic-token-bar')[1]).not.toHaveAttribute('data-token-count', '900');
    expect(screen.getAllByTestId('topic-token-bar')[2]).not.toHaveAttribute('data-token-count');

    messages.current = [{}] as never[];
    view.rerender(<TopicMapModal task={task} onScrollToMessage={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('topic-token-bar')[0]).toHaveAttribute('data-token-count', '100'));
    expect(screen.getAllByTestId('topic-token-bar')[1]).toHaveAttribute('data-token-count', '200');
    expect(screen.getAllByTestId('topic-token-bar')[1]).toHaveStyle({ width: 'calc(max(2.2rem, 2em) * 1)' });
    expect(screen.getAllByTestId('topic-token-bar')[2]).not.toHaveAttribute('data-token-count');
    expect(screen.getAllByTestId('topic-token-bar')[2]).toHaveAttribute('data-token-bar-fill', '0');
  });

  it('keeps token bars before the fixed controls slot', async () => {
    render(<TopicMapModal task={task} onScrollToMessage={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('topic-token-controls')).toHaveLength(3));
    for (const controls of screen.getAllByTestId('topic-token-controls')) {
      expect(controls).toHaveClass('w-5');
      const bar = controls.previousElementSibling as HTMLElement;
      expect(bar).toHaveAttribute('data-testid', 'topic-token-bar');
      expect(bar).not.toHaveClass('w-[2.2rem]');
      expect(bar).toHaveClass('token-footprint-motion');
      expect(bar.previousElementSibling).toHaveClass('mr-[calc(1em_-_0.25rem)]');
      expect(bar.previousElementSibling?.textContent).toMatch(/^\d/);
    }
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
