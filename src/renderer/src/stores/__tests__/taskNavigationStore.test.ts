import { beforeEach, describe, expect, it } from 'vitest';

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
});
