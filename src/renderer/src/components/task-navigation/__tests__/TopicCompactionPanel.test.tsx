import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopicCompactionPreview } from '@common/types';

import { TopicCompactionPanel } from '../TopicCompactionPanel';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { useApi } from '@/contexts/ApiContext';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';

vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(),
}));

// Shows interpolation values, so the word estimates can be asserted
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

const BASE_DIR = '/project';
const TASK_ID = 'task-1';
const target = { topicIndex: 0, firstMessageId: 'a1' };

const compactablePreview: TopicCompactionPreview = {
  compactable: true,
  firstMessageId: 'a1',
  endBeforeMessageId: 'b1',
  messageCount: 12,
  sourceCharacters: 6000,
  sourceTokens: 16000,
  targetCharacters: { 1: 300, 2: 600, 3: 1000, 4: 1600, 5: 2700 },
};

const renderPanel = () => {
  const onCancel = vi.fn();
  const onStarted = vi.fn();
  render(
    <TopicCompactionPanel
      baseDir={BASE_DIR}
      taskId={TASK_ID}
      target={target}
      title="Planning the change"
      onCancel={onCancel}
      onStarted={onStarted}
      onScrollToMessage={vi.fn()}
    />,
  );
  return { onCancel, onStarted };
};

describe('TopicCompactionPanel', () => {
  let mockApi: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    mockApi = createMockApi();
    vi.mocked(useApi).mockReturnValue(mockApi);
    useTaskNavigationStore.setState({ pendingCompactions: {}, compactionLevel: 1 });
  });

  it('shows the five levels with word estimates from the preview', async () => {
    mockApi.previewTopicCompaction.mockResolvedValue(compactablePreview);
    renderPanel();

    expect(await screen.findByText(/panel\.levels\.1$/)).toBeInTheDocument();
    for (const [level, words] of [
      [1, 50],
      [2, 100],
      [3, 167],
      [4, 267],
      [5, 450],
    ]) {
      expect(screen.getByText(new RegExp(`panel\\.levels\\.${level}$`))).toBeInTheDocument();
      expect(screen.getByText(`taskNavigation.compaction.panel.words {"words":${words}}`)).toBeInTheDocument();
    }
    expect(screen.getByText('taskNavigation.compaction.panel.size {"count":12,"words":1000,"tokens":"16k"}')).toBeInTheDocument();
    expect(mockApi.previewTopicCompaction).toHaveBeenCalledWith(BASE_DIR, TASK_ID, target);
  });

  it('compacts at level 3 with 3 then Enter, and remembers the level', async () => {
    mockApi.previewTopicCompaction.mockResolvedValue(compactablePreview);
    const { onStarted } = renderPanel();
    await screen.findByText(/panel\.levels\.3$/);

    const panel = screen.getByTestId('topic-compaction-panel');
    fireEvent.keyDown(panel, { key: '3' });
    fireEvent.keyDown(panel, { key: 'Enter' });

    await waitFor(() => expect(mockApi.compactTopic).toHaveBeenCalledWith(BASE_DIR, TASK_ID, target, { level: 3 }));
    expect(onStarted).toHaveBeenCalled();
    expect(useTaskNavigationStore.getState().compactionLevel).toBe(3);
  });

  it('shows the reason and only a Close button when the preview refuses', async () => {
    mockApi.previewTopicCompaction.mockResolvedValue({ compactable: false, reason: 'tool-pairs', messageCount: 0, sourceCharacters: 0, targetCharacters: {} });
    const { onCancel } = renderPanel();

    expect(await screen.findByText('taskNavigation.compaction.reasons.tool-pairs')).toBeInTheDocument();
    expect(screen.queryByText(/panel\.levels\.1$/)).toBeNull();
    expect(screen.queryByText('taskNavigation.compaction.panel.confirm')).toBeNull();

    fireEvent.click(screen.getByText('taskNavigation.compaction.panel.close'));
    expect(onCancel).toHaveBeenCalled();
    expect(mockApi.compactTopic).not.toHaveBeenCalled();
  });

  it('goes back to the list on Escape', async () => {
    mockApi.previewTopicCompaction.mockResolvedValue(compactablePreview);
    const { onCancel } = renderPanel();
    await screen.findByText(/panel\.levels\.1$/);

    fireEvent.keyDown(screen.getByTestId('topic-compaction-panel'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(mockApi.compactTopic).not.toHaveBeenCalled();
  });
});
