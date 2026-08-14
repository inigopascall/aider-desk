import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addBookmark,
  clearTaskBookmarks,
  pruneTaskBookmarks,
  toggleBookmark,
  useBookmarkStore,
} from '../bookmarkStore';

describe('bookmarkStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useBookmarkStore.setState({ bookmarksByTask: {} });
  });

  it('adds a bookmark for a task', () => {
    addBookmark('taskA', 'm1', 'Hello');

    const bookmark = useBookmarkStore.getState().bookmarksByTask.taskA.m1;
    expect(bookmark.id).toBe('m1');
    expect(bookmark.label).toBe('Hello');
    expect(typeof bookmark.createdAt).toBe('number');
  });

  it('toggles a bookmark for the same task and message', () => {
    toggleBookmark('taskA', 'm1', 'Hello');
    expect(useBookmarkStore.getState().bookmarksByTask.taskA.m1).toBeDefined();

    toggleBookmark('taskA', 'm1', 'Hello');
    expect(useBookmarkStore.getState().bookmarksByTask.taskA).toBeUndefined();
  });

  it('keeps bookmarks for other tasks when pruning', () => {
    addBookmark('taskA', 'm1', 'Task A');
    addBookmark('taskB', 'm2', 'Task B');

    pruneTaskBookmarks('taskB', new Set(['other']));

    expect(useBookmarkStore.getState().bookmarksByTask.taskA.m1).toBeDefined();
    expect(useBookmarkStore.getState().bookmarksByTask.taskB).toBeUndefined();
  });

  it('does not persist when pruning retains every bookmark', () => {
    addBookmark('taskA', 'm1', 'Hello');

    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    pruneTaskBookmarks('taskA', new Set(['m1']));

    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('clears bookmarks only for the requested task', () => {
    addBookmark('taskA', 'm1', 'Task A');
    addBookmark('taskB', 'm2', 'Task B');

    clearTaskBookmarks('taskA');

    expect(useBookmarkStore.getState().bookmarksByTask.taskA).toBeUndefined();
    expect(useBookmarkStore.getState().bookmarksByTask.taskB.m2).toBeDefined();
  });

  it('persists task-scoped bookmarks', () => {
    addBookmark('taskA', 'm1', 'Hello');

    const stored = JSON.parse(localStorage.getItem('aider-desk-bookmarks-v2') ?? '{}');
    expect(stored.taskA.m1.id).toBe('m1');
  });

  it('tolerates corrupt and array-shaped storage', async () => {
    localStorage.setItem('aider-desk-bookmarks-v2', 'not json');
    vi.resetModules();
    const corruptModule = await import('../bookmarkStore');
    expect(corruptModule.useBookmarkStore.getState().bookmarksByTask).toEqual({});

    localStorage.setItem('aider-desk-bookmarks-v2', '[1,2,3]');
    vi.resetModules();
    const arrayModule = await import('../bookmarkStore');
    expect(arrayModule.useBookmarkStore.getState().bookmarksByTask).toEqual({});
  });
});
