import { SEARCH_TASK_ROW_MESSAGE_ID } from '@common/types';
import { createWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/vanilla/shallow';

import { useCommandPaletteStore } from '@/stores/commandPaletteStore';

export interface TaskActivationRequest {
  baseDir: string;
  taskId: string;
  /** Message to scroll to once the task is shown. */
  messageId?: string;
  nonce: number;
}

export interface MessageScrollRequest {
  taskId: string;
  messageId: string;
  nonce: number;
}

/** Where the topic map of a task was left: the selected row and the expanded topics. */
export interface TopicMapViewState {
  /** `topic:<topic index>` or `message:<topic index>:<message id>`; null selects the latest topic. */
  selected: string | null;
  /** Indexes of the expanded topics. */
  expanded: number[];
}

/** Order of global search results: best match first, or most recently updated task first. */
export type SearchOrder = 'relevance' | 'recent';

type TaskNavigationStore = {
  quickSwitcherOpen: boolean;
  globalSearchOpen: boolean;
  globalSearchInitialQuery: string;
  searchOrder: SearchOrder;
  topicMapOpen: boolean;
  /** View key of the task that hosts the topic map: the active task of the active project. */
  topicMapHost: string | null;
  topicMapViews: Record<string, TopicMapViewState>;
  pendingActivation: TaskActivationRequest | null;
  pendingScroll: MessageScrollRequest | null;

  toggleQuickSwitcher: () => void;
  closeQuickSwitcher: () => void;
  openGlobalSearch: (initialQuery?: string) => void;
  toggleGlobalSearch: () => void;
  closeGlobalSearch: () => void;
  toggleSearchOrder: () => void;
  toggleTopicMap: () => void;
  closeTopicMap: () => void;
  setTopicMapHost: (viewKey: string) => void;
  releaseTopicMapHost: (viewKey: string) => void;
  setTopicMapView: (viewKey: string, view: TopicMapViewState) => void;
  requestTaskActivation: (baseDir: string, taskId: string, messageId?: string) => void;
  completeTaskActivation: (nonce: number) => void;
  completeMessageScroll: (nonce: number) => void;
};

const SEARCH_ORDER_STORAGE_KEY = 'task-navigation-search-order';
const TOPIC_MAP_VIEWS_STORAGE_KEY = 'task-navigation-topic-map-views';
const MAX_STORED_TOPIC_MAP_VIEWS = 100;

const readStorage = (key: string): unknown => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors.
  }
};

const loadSearchOrder = (): SearchOrder => (readStorage(SEARCH_ORDER_STORAGE_KEY) === 'recent' ? 'recent' : 'relevance');

const loadTopicMapViews = (): Record<string, TopicMapViewState> => {
  const stored = readStorage(TOPIC_MAP_VIEWS_STORAGE_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  const views: Record<string, TopicMapViewState> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const view = value as Partial<TopicMapViewState> | null;
    if (view && Array.isArray(view.expanded)) {
      views[key] = {
        selected: typeof view.selected === 'string' ? view.selected : null,
        expanded: view.expanded.filter((index) => Number.isInteger(index)),
      };
    }
  }
  return views;
};

const closeCommandPalette = () => {
  const palette = useCommandPaletteStore.getState();
  if (palette.isOpen) {
    palette.closePalette();
  }
};

export const getTopicMapViewKey = (baseDir: string, taskId: string): string => `${baseDir}::${taskId}`;

let nextNonce = 1;

export const useTaskNavigationStore = createWithEqualityFn<TaskNavigationStore>()(
  (set, get) => ({
    quickSwitcherOpen: false,
    globalSearchOpen: false,
    globalSearchInitialQuery: '',
    searchOrder: loadSearchOrder(),
    topicMapOpen: false,
    topicMapHost: null,
    topicMapViews: loadTopicMapViews(),
    pendingActivation: null,
    pendingScroll: null,

    toggleQuickSwitcher: () => {
      const open = !get().quickSwitcherOpen;
      if (open) {
        closeCommandPalette();
      }
      set({ quickSwitcherOpen: open, globalSearchOpen: false, topicMapOpen: false });
    },
    closeQuickSwitcher: () => set({ quickSwitcherOpen: false }),
    openGlobalSearch: (initialQuery = '') => {
      closeCommandPalette();
      set({ globalSearchOpen: true, globalSearchInitialQuery: initialQuery, quickSwitcherOpen: false, topicMapOpen: false });
    },
    toggleGlobalSearch: () => {
      if (get().globalSearchOpen) {
        set({ globalSearchOpen: false });
      } else {
        get().openGlobalSearch();
      }
    },
    closeGlobalSearch: () => set({ globalSearchOpen: false }),
    toggleSearchOrder: () => {
      const searchOrder: SearchOrder = get().searchOrder === 'recent' ? 'relevance' : 'recent';
      writeStorage(SEARCH_ORDER_STORAGE_KEY, searchOrder);
      set({ searchOrder });
    },
    toggleTopicMap: () => {
      const { topicMapOpen, topicMapHost } = get();
      if (topicMapOpen) {
        set({ topicMapOpen: false });
        return;
      }
      if (!topicMapHost) {
        return;
      }
      closeCommandPalette();
      set({ topicMapOpen: true, quickSwitcherOpen: false, globalSearchOpen: false });
    },
    closeTopicMap: () => set({ topicMapOpen: false }),
    setTopicMapHost: (viewKey) => set({ topicMapHost: viewKey }),
    releaseTopicMapHost: (viewKey) => {
      if (get().topicMapHost === viewKey) {
        set({ topicMapHost: null, topicMapOpen: false });
      }
    },
    setTopicMapView: (viewKey, view) => {
      const views = { ...get().topicMapViews };
      delete views[viewKey];
      views[viewKey] = view;
      const keys = Object.keys(views);
      for (const oldKey of keys.slice(0, Math.max(0, keys.length - MAX_STORED_TOPIC_MAP_VIEWS))) {
        delete views[oldKey];
      }
      writeStorage(TOPIC_MAP_VIEWS_STORAGE_KEY, views);
      set({ topicMapViews: views });
    },
    requestTaskActivation: (baseDir, taskId, messageId) => {
      const nonce = nextNonce++;
      const scrollTarget = messageId && messageId !== SEARCH_TASK_ROW_MESSAGE_ID ? messageId : undefined;
      set({
        pendingActivation: { baseDir, taskId, messageId: scrollTarget, nonce },
        pendingScroll: scrollTarget ? { taskId, messageId: scrollTarget, nonce } : null,
      });
    },
    completeTaskActivation: (nonce) => {
      if (get().pendingActivation?.nonce === nonce) {
        set({ pendingActivation: null });
      }
    },
    completeMessageScroll: (nonce) => {
      if (get().pendingScroll?.nonce === nonce) {
        set({ pendingScroll: null });
      }
    },
  }),
  shallow,
);
