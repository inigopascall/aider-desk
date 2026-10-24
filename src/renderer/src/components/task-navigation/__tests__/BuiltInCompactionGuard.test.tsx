import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TASK_NAVIGATION_METADATA_KEYS, TaskData, TaskTopic, TopicCompactionInfo, taskHasTopicCompactions } from '@common/types';

import { useBuiltInCompactionGuard } from '../BuiltInCompactionGuard';

import { render } from '@/__tests__/render';
import { useProjectStore } from '@/stores/projectStore';

const BASE_DIR = '/project';
const TASK_ID = 'task-1';

const record: TopicCompactionInfo = {
  id: 'abc',
  level: 3,
  compactedAt: '2026-10-24T10:00:00.000Z',
  summaryMessageId: 'topic-compaction-abc',
  promptMessageId: 'topic-compaction-abc-prompt',
  messageCount: 4,
  sourceCharacters: 1200,
  summaryCharacters: 300,
};

const makeTask = (topics: TaskTopic[]): TaskData =>
  ({
    id: TASK_ID,
    baseDir: BASE_DIR,
    name: 'Task',
    metadata: { [TASK_NAVIGATION_METADATA_KEYS.taskSummary]: { title: 'Task', generatedAt: '2026-10-24T10:00:00.000Z', topics } },
  }) as unknown as TaskData;

const setTopics = (topics: TaskTopic[]) => useProjectStore.setState({ projectTasksMap: new Map([[BASE_DIR, [makeTask(topics)]]]) });

const Harness = ({ run }: { run: () => void }) => {
  const { guardBuiltInCompaction, builtInCompactionDialog } = useBuiltInCompactionGuard(BASE_DIR, TASK_ID);
  return (
    <>
      <button type="button" onClick={() => guardBuiltInCompaction('/compact', run)}>
        run command
      </button>
      {builtInCompactionDialog}
    </>
  );
};

describe('taskHasTopicCompactions', () => {
  it('is true only when a topic or a section holds a compaction record', () => {
    expect(taskHasTopicCompactions(makeTask([{ summary: 'Plain', messageIds: ['a1'] }]))).toBe(false);
    expect(taskHasTopicCompactions(makeTask([{ summary: 'Topic', messageIds: ['a1'], compaction: record }]))).toBe(true);
    expect(
      taskHasTopicCompactions(
        makeTask([{ summary: 'Sectioned', messageIds: ['a1'], sections: [{ summary: 'Section', startMessageId: 'a1', compaction: record }] }]),
      ),
    ).toBe(true);
    expect(taskHasTopicCompactions({})).toBe(false);
  });
});

describe('useBuiltInCompactionGuard', () => {
  it('runs the command at once when the task has no compactions', () => {
    setTopics([{ summary: 'Plain', messageIds: ['a1'] }]);
    const run = vi.fn();
    render(<Harness run={run} />);

    fireEvent.click(screen.getByText('run command'));

    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('taskNavigation.compaction.builtIn.title')).toBeNull();
  });

  it('asks first when the task has compactions: cancel does not run the command, continue does', () => {
    setTopics([{ summary: 'Topic', messageIds: ['a1'], compaction: record }]);
    const run = vi.fn();
    render(<Harness run={run} />);

    fireEvent.click(screen.getByText('run command'));
    expect(screen.getByText('taskNavigation.compaction.builtIn.title')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByText('taskNavigation.compaction.builtIn.title')).toBeNull();

    fireEvent.click(screen.getByText('run command'));
    fireEvent.click(screen.getByText('taskNavigation.compaction.builtIn.confirm'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('taskNavigation.compaction.builtIn.title')).toBeNull();
  });
});
