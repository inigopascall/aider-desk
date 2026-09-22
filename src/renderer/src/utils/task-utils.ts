import { DEFAULT_TASK_STATES, TaskData } from '@common/types';

import { getTaskDateGroup } from './date-utils';

export type VirtualTaskItem = { type: 'header'; id: string; title: string } | { type: 'task'; id: string; task: TaskData; level: number };

export type TaskSortOrder = 'createdAt' | 'updatedAt';

export const getTaskDir = (task: TaskData): string => task.worktree?.path ?? task.baseDir;

export const countAllSubtasks = (taskId: string, allTasks: TaskData[]): number =>
  allTasks.filter((t) => t.parentId === taskId).reduce((count, subtask) => count + 1 + countAllSubtasks(subtask.id, allTasks), 0);

const getMostRecentUpdatedAt = (task: TaskData, allTasks: TaskData[]): string | undefined => {
  let mostRecent = task.updatedAt;

  const subtasks = allTasks.filter((t) => t.parentId === task.id);
  for (const subtask of subtasks) {
    const subtaskMostRecent = getMostRecentUpdatedAt(subtask, allTasks);
    if (subtaskMostRecent && (!mostRecent || subtaskMostRecent > mostRecent)) {
      mostRecent = subtaskMostRecent;
    }
  }

  return mostRecent;
};

export const getSortedVisibleTasks = (
  tasks: TaskData[],
  selectedStates: Set<string>,
  showArchived: boolean = false,
  searchQuery: string = '',
  sortOrder: TaskSortOrder = 'createdAt',
): TaskData[] => {
  const filteredTasks = tasks
    .filter((task) => {
      if (task.archived && !showArchived) {
        return false;
      }
      if (task.state && DEFAULT_TASK_STATES.has(task.state) && !selectedStates.has(task.state)) {
        return false;
      }
      return true;
    })
    .filter((task) => {
      if (!searchQuery.trim()) {
        return true;
      }
      const searchText = searchQuery.toLowerCase();
      return task.name.toLowerCase().includes(searchText);
    });

  // A task is hidden along with any archived ancestor, not just an archived
  // direct parent, so deeper descendants do not surface at the root.
  const hasArchivedAncestor = (task: TaskData): boolean => {
    const seen = new Set<string>([task.id]);
    let parentId = task.parentId;
    while (parentId && !seen.has(parentId)) {
      const parent = tasks.find((t) => t.id === parentId);
      if (!parent) {
        return false;
      }
      if (parent.archived) {
        return true;
      }
      seen.add(parent.id);
      parentId = parent.parentId;
    }
    return false;
  };

  const tasksWithValidParents = showArchived ? filteredTasks : filteredTasks.filter((task) => !hasArchivedAncestor(task));

  const topLevelTasks = tasksWithValidParents.filter((t) => !t.parentId || !tasksWithValidParents.some((p) => p.id === t.parentId));
  const subtasks = tasksWithValidParents.filter((t) => t.parentId && tasksWithValidParents.some((p) => p.id === t.parentId));

  const sortFn = (a: TaskData, b: TaskData) => {
    // Pinned tasks come first
    if (a.pinned && !b.pinned) {
      return -1;
    }
    if (!a.pinned && b.pinned) {
      return 1;
    }

    if (sortOrder === 'createdAt') {
      // Sort by the task's own creation date (descending). Unlike updatedAt,
      // this never changes for a task, so list order stays fixed across edits.
      const aCreated = a.createdAt;
      const bCreated = b.createdAt;
      if (aCreated && !bCreated) {
        return 1;
      } else if (!aCreated && bCreated) {
        return -1;
      } else if (!aCreated && !bCreated) {
        return 0;
      } else {
        return bCreated!.localeCompare(aCreated!);
      }
    }

    // sortOrder === 'updatedAt': existing behavior — most recent updatedAt
    // (including subtasks, descending)
    const aMostRecent = getMostRecentUpdatedAt(a, filteredTasks);
    const bMostRecent = getMostRecentUpdatedAt(b, filteredTasks);
    if (aMostRecent && !bMostRecent) {
      return 1;
    } else if (!aMostRecent && bMostRecent) {
      return -1;
    } else if (!aMostRecent && !bMostRecent) {
      return 0;
    } else {
      return bMostRecent!.localeCompare(aMostRecent!);
    }
  };

  const sortedTopLevel = [...topLevelTasks].sort(sortFn);

  const addTaskWithChildren = (task: TaskData) => {
    result.push(task);
    const children = subtasks.filter((t) => t.parentId === task.id).sort(sortFn);
    children.forEach(addTaskWithChildren);
  };

  const result: TaskData[] = [];
  sortedTopLevel.forEach(addTaskWithChildren);

  return result;
};

export const flattenTasksForVirtualization = (
  tasks: TaskData[],
  expandedIds: Set<string>,
  selectedStates: Set<string>,
  showArchived: boolean = false,
  searchQuery: string = '',
  sortOrder: TaskSortOrder = 'createdAt',
): VirtualTaskItem[] => {
  const sortedTasks = getSortedVisibleTasks(tasks, selectedStates, showArchived, searchQuery, sortOrder);
  const topLevelTasks = sortedTasks.filter((task) => !task.parentId || !sortedTasks.some((t) => t.id === task.parentId));

  const pinnedTasks = topLevelTasks.filter((task) => task.pinned);
  const nonPinnedTasks = topLevelTasks.filter((task) => !task.pinned);

  const result: VirtualTaskItem[] = [];

  const addTaskWithSubtasks = (task: TaskData, level: number) => {
    result.push({ type: 'task', id: task.id, task, level });

    if (expandedIds.has(task.id)) {
      const subtasks = sortedTasks.filter((t) => t.parentId === task.id);
      subtasks.forEach((subtask) => addTaskWithSubtasks(subtask, level + 1));
    }
  };

  // Add pinned tasks first (without header)
  pinnedTasks.forEach((task) => addTaskWithSubtasks(task, 0));

  const groupedTasks = new Map<string, TaskData[]>();
  nonPinnedTasks.forEach((task) => {
    const groupDate = sortOrder === 'createdAt' ? task.createdAt : getMostRecentUpdatedAt(task, sortedTasks);
    const group = groupDate ? getTaskDateGroup({ ...task, updatedAt: groupDate }) : getTaskDateGroup(task);
    if (!groupedTasks.has(group)) {
      groupedTasks.set(group, []);
    }
    groupedTasks.get(group)!.push(task);
  });

  groupedTasks.forEach((groupTasks, dateGroup) => {
    result.push({ type: 'header', id: `date-${dateGroup}`, title: dateGroup });
    groupTasks.forEach((task) => addTaskWithSubtasks(task, 0));
  });

  return result;
};
