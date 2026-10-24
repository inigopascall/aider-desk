import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTopicMapViewKey, useTaskNavigationStore } from '../taskNavigationStore';

describe('taskNavigationStore', () => {
  beforeEach(() => {
    useTaskNavigationStore.setState({ topicMapOpen: false, topicMapHost: null, quickSwitcherOpen: false, globalSearchOpen: false });
  });

  it('opens the topic map only while a task hosts it, and closes it when the host leaves', () => {
    const store = useTaskNavigationStore.getState();
    store.toggleTopicMap();
    expect(useTaskNavigationStore.getState().topicMapOpen).toBe(false);

    const key = getTopicMapViewKey('/p', 't1');
    store.setTopicMapHost(key);
    store.toggleTopicMap();
    expect(useTaskNavigationStore.getState().topicMapOpen).toBe(true);

    store.releaseTopicMapHost(getTopicMapViewKey('/p', 'other'));
    expect(useTaskNavigationStore.getState().topicMapOpen).toBe(true);

    store.releaseTopicMapHost(key);
    expect(useTaskNavigationStore.getState()).toMatchObject({ topicMapOpen: false, topicMapHost: null });
  });

  it('closes the topic map when another overlay opens', () => {
    const store = useTaskNavigationStore.getState();
    store.setTopicMapHost('k');
    store.toggleTopicMap();
    store.toggleQuickSwitcher();
    expect(useTaskNavigationStore.getState()).toMatchObject({ quickSwitcherOpen: true, topicMapOpen: false });

    store.toggleTopicMap();
    expect(useTaskNavigationStore.getState()).toMatchObject({ quickSwitcherOpen: false, topicMapOpen: true });
  });

  it('remembers and stores the topic map view of each task', () => {
    useTaskNavigationStore.getState().setTopicMapView('k1', { selected: 'topic:2', expanded: [2] });

    expect(useTaskNavigationStore.getState().topicMapViews.k1).toEqual({ selected: 'topic:2', expanded: [2] });
    expect(JSON.parse(localStorage.getItem('task-navigation-topic-map-views') ?? '{}').k1).toEqual({ selected: 'topic:2', expanded: [2] });
  });

  it('switches the search order and stores it', () => {
    const before = useTaskNavigationStore.getState().searchOrder;
    useTaskNavigationStore.getState().toggleSearchOrder();
    const after = useTaskNavigationStore.getState().searchOrder;

    expect(after).not.toBe(before);
    expect(JSON.parse(localStorage.getItem('task-navigation-search-order') ?? 'null')).toBe(after);
  });

  it('keeps pending compactions until the matching nonce ends them', () => {
    useTaskNavigationStore.setState({ pendingCompactions: {} });
    const store = useTaskNavigationStore.getState();

    const first = store.startPendingCompaction('m1', 'm5');
    const second = store.startPendingCompaction('m9', null);
    expect(second).not.toBe(first);
    expect(useTaskNavigationStore.getState().pendingCompactions).toEqual({
      m1: { endBeforeMessageId: 'm5', nonce: first },
      m9: { endBeforeMessageId: null, nonce: second },
    });

    store.endPendingCompaction('m1', second);
    expect(useTaskNavigationStore.getState().pendingCompactions.m1).toBeDefined();

    store.endPendingCompaction('m1', first);
    expect(useTaskNavigationStore.getState().pendingCompactions).toEqual({ m9: { endBeforeMessageId: null, nonce: second } });
    expect(localStorage.getItem('task-navigation-pending-compactions')).toBeNull();
  });

  it('remembers the compaction level, clamped to 1–5, in localStorage', () => {
    const store = useTaskNavigationStore.getState();

    store.setCompactionLevel(5);
    expect(useTaskNavigationStore.getState().compactionLevel).toBe(5);
    expect(JSON.parse(localStorage.getItem('task-navigation-compaction-level') ?? 'null')).toBe(5);

    store.setCompactionLevel(9);
    expect(useTaskNavigationStore.getState().compactionLevel).toBe(5);
    store.setCompactionLevel(0);
    expect(useTaskNavigationStore.getState().compactionLevel).toBe(1);
  });

  it('loads the remembered compaction level, and defaults to level 3', async () => {
    localStorage.setItem('task-navigation-compaction-level', '4');
    vi.resetModules();
    const stored = await import('../taskNavigationStore');
    expect(stored.useTaskNavigationStore.getState().compactionLevel).toBe(4);

    localStorage.removeItem('task-navigation-compaction-level');
    vi.resetModules();
    const fresh = await import('../taskNavigationStore');
    expect(fresh.useTaskNavigationStore.getState().compactionLevel).toBe(3);
  });
});
