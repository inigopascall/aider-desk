import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultTaskState, TASK_NAVIGATION_METADATA_KEYS, TaskData } from '@common/types';

import { QuickSwitcher } from '../QuickSwitcher';
import { GENERATING_TASK_NAME } from '../utils';

import { render } from '@/__tests__/render';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';

vi.mock('@/hooks/useOverlayFocusRestore', () => ({
  useOverlayRegistration: vi.fn(),
}));

vi.mock('@/components/project/TaskSidebar/TaskStatusIcon', () => ({
  TaskStatusIcon: () => null,
}));

const ALPHA_DIR = '/projects/alpha';
const BETA_DIR = '/projects/beta';
const SUMMARY_DATE = '2026-10-24T10:00:00.000Z';

type TaskMetadata = Record<string, unknown>;

const makeTask = (overrides: Partial<TaskData> = {}, taskNumber: number | null = 1): TaskData => {
  const name = overrides.name ?? 'Task';
  const metadata: TaskMetadata = {
    [TASK_NAVIGATION_METADATA_KEYS.taskSummary]: {
      title: `${name} summary`,
      topics: [],
      generatedAt: SUMMARY_DATE,
    },
    [TASK_NAVIGATION_METADATA_KEYS.lastMessagePreview]: {
      role: 'assistant',
      text: `${name} preview`,
    },
    ...(overrides.metadata ?? {}),
  };
  if (taskNumber !== null) {
    metadata[TASK_NAVIGATION_METADATA_KEYS.taskNumber] = taskNumber;
  } else {
    delete metadata[TASK_NAVIGATION_METADATA_KEYS.taskNumber];
  }

  return {
    id: 'task',
    baseDir: ALPHA_DIR,
    name,
    state: DefaultTaskState.Done,
    createdAt: '2026-10-24T08:00:00.000Z',
    updatedAt: '2026-10-24T09:00:00.000Z',
    aiderTotalCost: 0,
    agentTotalCost: 0,
    mainModel: 'test/model',
    ...overrides,
    metadata,
  } as TaskData;
};

const summaryMetadata = (title: string, topics: string[], preview: string): TaskMetadata => ({
  [TASK_NAVIGATION_METADATA_KEYS.taskSummary]: {
    title,
    topics: topics.map((summary, index) => ({ summary, messageIds: [`${title}-${index}`] })),
    generatedAt: SUMMARY_DATE,
  },
  [TASK_NAVIGATION_METADATA_KEYS.lastMessagePreview]: { role: 'assistant', text: preview },
});

const resetStores = () => {
  useProjectStore.setState({ projectTasksMap: new Map() });
  useSettingsStore.setState({ settings: null, theme: null, font: null, fontSize: null, readonlyExtensionUi: null });
  useTaskNavigationStore.setState({
    quickSwitcherOpen: false,
    globalSearchOpen: false,
    globalSearchInitialQuery: '',
    searchOrder: 'relevance',
    topicMapOpen: false,
    topicMapHost: null,
    topicMapViews: {},
    pendingActivation: null,
    pendingScroll: null,
    pendingCompactions: {},
  });
};

const openSwitcher = () => {
  useTaskNavigationStore.setState({ quickSwitcherOpen: true });
  render(<QuickSwitcher />);
};

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-index]'));

const rowFor = (text: string): HTMLElement => {
  const row = screen.getByText(text).closest<HTMLElement>('[data-index]');
  if (!row) {
    throw new Error(`No quick switcher row contains ${text}`);
  }
  return row;
};

describe('QuickSwitcher parent context', () => {
  beforeEach(() => {
    resetStores();
  });

  it('keeps an archived parent as context, but selects the child when its title is clicked', () => {
    const parent = makeTask(
      {
        id: 'archived-parent',
        name: 'Archived Parent',
        archived: true,
        updatedAt: '2026-10-24T07:00:00.000Z',
        metadata: summaryMetadata('Parent-only title', ['parent-only-topic'], 'parent-only-preview'),
      },
      1,
    );
    const child = makeTask(
      {
        id: 'child',
        name: 'Visible Child',
        parentId: parent.id,
        updatedAt: '2026-10-24T09:00:00.000Z',
        metadata: summaryMetadata('Child-only title', ['child-only-topic'], 'child-only-preview'),
      },
      2,
    );
    useProjectStore.setState({ projectTasksMap: new Map([[ALPHA_DIR, [parent, child]]]) });
    openSwitcher();

    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    const rowView = within(row);
    expect(rowView.getByText('ALP-001')).toBeInTheDocument();
    expect(rowView.getByText('Archived Parent')).toBeInTheDocument();
    expect(rowView.getByText('ALP-002')).toBeInTheDocument();
    expect(rowView.getByText('Visible Child')).toBeInTheDocument();
    expect(rowView.getByText('child-only-topic')).toBeInTheDocument();
    expect(rowView.getByText(/child-only-preview/)).toBeInTheDocument();
    expect(rowView.queryByText('parent-only-topic')).toBeNull();
    expect(rowView.queryByText(/parent-only-preview/)).toBeNull();
    expect(row.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();

    const text = row.textContent ?? '';
    expect(text.indexOf('ALP-001')).toBeLessThan(text.indexOf('Archived Parent'));
    expect(text.indexOf('Archived Parent')).toBeLessThan(text.indexOf('Visible Child'));

    fireEvent.click(rowView.getByText('Archived Parent'));
    expect(useTaskNavigationStore.getState().pendingActivation?.taskId).toBe(child.id);
    expect(useTaskNavigationStore.getState().pendingActivation?.baseDir).toBe(ALPHA_DIR);
  });

  it('keeps parent context out of the result order, so ArrowDown selects the next actual task', () => {
    const parent = makeTask({ id: 'parent', name: 'Archived Parent', archived: true }, 1);
    const child = makeTask(
      {
        id: 'recent-child',
        name: 'Recent Child',
        parentId: parent.id,
        updatedAt: '2026-10-24T09:00:00.000Z',
      },
      2,
    );
    const next = makeTask(
      {
        id: 'next-task',
        name: 'Next Task',
        updatedAt: '2026-10-24T08:30:00.000Z',
      },
      3,
    );
    useProjectStore.setState({ projectTasksMap: new Map([[ALPHA_DIR, [parent, child, next]]]) });
    openSwitcher();

    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]).getByText('Recent Child')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('Next Task')).toBeInTheDocument();

    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useTaskNavigationStore.getState().pendingActivation?.taskId).toBe(next.id);
    expect(useTaskNavigationStore.getState().pendingActivation?.taskId).not.toBe(parent.id);
  });

  it('resolves the same parent id within each project rather than across projects', () => {
    const sharedParentId = 'shared-parent';
    const firstParent = makeTask({ id: sharedParentId, name: 'Alpha Parent', updatedAt: '2026-10-24T07:00:00.000Z' }, 11);
    const firstChild = makeTask({ id: 'alpha-child', name: 'Alpha Child', parentId: sharedParentId, updatedAt: '2026-10-24T09:00:00.000Z' }, 12);
    const secondParent = makeTask({ id: sharedParentId, baseDir: BETA_DIR, name: 'Beta Parent', updatedAt: '2026-10-24T07:00:00.000Z' }, 21);
    const secondChild = makeTask(
      { id: 'beta-child', baseDir: BETA_DIR, name: 'Beta Child', parentId: sharedParentId, updatedAt: '2026-10-24T08:30:00.000Z' },
      22,
    );
    useProjectStore.setState({
      projectTasksMap: new Map([
        [ALPHA_DIR, [firstParent, firstChild]],
        [BETA_DIR, [secondParent, secondChild]],
      ]),
    });
    openSwitcher();

    const alphaRow = rowFor('Alpha Child');
    const betaRow = rowFor('Beta Child');
    expect(within(alphaRow).getByText('Alpha Parent')).toBeInTheDocument();
    expect(within(alphaRow).queryByText('Beta Parent')).toBeNull();
    expect(within(betaRow).getByText('Beta Parent')).toBeInTheDocument();
    expect(within(betaRow).queryByText('Alpha Parent')).toBeNull();
  });

  it('renders top-level, missing-parent, and self-parent tasks without parent decoration and keeps them clickable', () => {
    const fixtures = [
      makeTask({ id: 'top-level', name: 'Top Level', parentId: null, updatedAt: '2026-10-24T09:00:00.000Z' }, 1),
      makeTask({ id: 'missing-parent', name: 'Missing Parent', parentId: 'does-not-exist', updatedAt: '2026-10-24T08:00:00.000Z' }, 2),
      makeTask({ id: 'self-parent', name: 'Self Parent', parentId: 'self-parent', updatedAt: '2026-10-24T07:00:00.000Z' }, 3),
    ];
    useProjectStore.setState({ projectTasksMap: new Map([[ALPHA_DIR, fixtures]]) });
    openSwitcher();

    for (const fixture of fixtures) {
      const row = rowFor(fixture.name);
      expect(row.querySelector('svg[aria-hidden="true"]')).toBeNull();
      expect(row.textContent).not.toContain('Subdirectory');
    }

    const missingRow = rowFor('Missing Parent');
    fireEvent.click(missingRow);
    expect(useTaskNavigationStore.getState().pendingActivation?.taskId).toBe('missing-parent');
  });

  it('retains parent context when filtering by the child key, while a parent title finds only the parent task', () => {
    const parent = makeTask(
      {
        id: 'archived-parent',
        name: 'Unique Archived Parent',
        archived: true,
        updatedAt: '2026-10-24T07:00:00.000Z',
        metadata: summaryMetadata('Unique parent title', ['parent topic'], 'parent preview'),
      },
      1,
    );
    const child = makeTask(
      {
        id: 'child',
        name: 'Unique Child',
        parentId: parent.id,
        updatedAt: '2026-10-24T09:00:00.000Z',
        metadata: summaryMetadata('Unique child title', ['child topic'], 'child preview'),
      },
      2,
    );
    useProjectStore.setState({ projectTasksMap: new Map([[ALPHA_DIR, [parent, child]]]) });
    openSwitcher();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'ALP-002' } });
    expect(rows()).toHaveLength(1);
    const childRow = rows()[0];
    expect(within(childRow).getByText('Unique Archived Parent')).toBeInTheDocument();
    expect(within(childRow).getByText('Unique Child')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Unique Archived Parent' } });
    expect(rows()).toHaveLength(1);
    const parentRow = rows()[0];
    expect(within(parentRow).getByText('Unique Archived Parent')).toBeInTheDocument();
    expect(within(parentRow).getByText(/parent preview/)).toBeInTheDocument();
    expect(within(parentRow).queryByText('Unique Child')).toBeNull();
    expect(within(parentRow).queryByText(/child preview/)).toBeNull();

    fireEvent.click(parentRow);
    expect(useTaskNavigationStore.getState().pendingActivation?.taskId).toBe(parent.id);
  });

  it("expands the selected child's topics rather than adding a parent's topics", () => {
    const parent = makeTask(
      {
        id: 'parent',
        name: 'Parent',
        archived: true,
        metadata: summaryMetadata('Parent summary', ['parent topic one', 'parent topic two'], 'parent preview'),
      },
      1,
    );
    const child = makeTask(
      {
        id: 'child',
        name: 'Child',
        parentId: parent.id,
        metadata: summaryMetadata('Child summary', ['child topic one', 'child topic two'], 'child preview'),
      },
      2,
    );
    useProjectStore.setState({ projectTasksMap: new Map([[ALPHA_DIR, [parent, child]]]) });
    openSwitcher();

    const input = screen.getByRole('textbox');
    const row = rows()[0];
    expect(within(row).getByText('child topic two')).toBeInTheDocument();
    expect(within(row).queryByText('child topic one')).toBeNull();
    expect(within(row).queryByText('parent topic one')).toBeNull();
    expect(within(row).queryByText('parent topic two')).toBeNull();

    fireEvent.keyDown(input, { key: 'Tab' });
    expect(within(rows()[0]).getByText('child topic one')).toBeInTheDocument();
    expect(within(rows()[0]).queryByText('parent topic one')).toBeNull();
    expect(within(rows()[0]).queryByText('parent topic two')).toBeNull();
  });

  it('shows a parent title even without a task number', () => {
    const parent = makeTask({ id: 'parent', name: 'Parent Without Number', archived: true }, null);
    const child = makeTask({ id: 'child', name: 'Child', parentId: parent.id }, 2);
    useProjectStore.setState({ projectTasksMap: new Map([[ALPHA_DIR, [parent, child]]]) });
    openSwitcher();

    const row = rows()[0];
    expect(within(row).getByText('Parent Without Number')).toBeInTheDocument();
    expect(within(row).getByText('ALP-002')).toBeInTheDocument();
    expect(within(row).queryByText('ALP-001')).toBeNull();
  });

  it.each([
    [GENERATING_TASK_NAME, 'taskNavigation.generatingName'],
    ['', 'taskNavigation.untitled'],
  ])('uses the existing fallback label for a %s task name', (name, fallback) => {
    const task = makeTask({ id: `task-${fallback}`, name, updatedAt: '2026-10-24T09:00:00.000Z' }, 1);
    useProjectStore.setState({ projectTasksMap: new Map([[ALPHA_DIR, [task]]]) });
    openSwitcher();

    expect(screen.getByText(fallback)).toBeInTheDocument();
    fireEvent.click(screen.getByText(fallback));
    expect(useTaskNavigationStore.getState().pendingActivation?.taskId).toBe(task.id);
  });
});
