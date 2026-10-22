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

type TaskNavigationStore = {
  quickSwitcherOpen: boolean;
  globalSearchOpen: boolean;
  globalSearchInitialQuery: string;
  topicPanelOpen: boolean;
  pendingActivation: TaskActivationRequest | null;
  pendingScroll: MessageScrollRequest | null;

  toggleQuickSwitcher: () => void;
  closeQuickSwitcher: () => void;
  openGlobalSearch: (initialQuery?: string) => void;
  toggleGlobalSearch: () => void;
  closeGlobalSearch: () => void;
  toggleTopicPanel: () => void;
  setTopicPanelOpen: (open: boolean) => void;
  requestTaskActivation: (baseDir: string, taskId: string, messageId?: string) => void;
  completeTaskActivation: (nonce: number) => void;
  completeMessageScroll: (nonce: number) => void;
};

const TOPIC_PANEL_STORAGE_KEY = 'task-navigation-topic-panel-open';

const loadTopicPanelOpen = (): boolean => {
  try {
    return localStorage.getItem(TOPIC_PANEL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

const saveTopicPanelOpen = (open: boolean) => {
  try {
    localStorage.setItem(TOPIC_PANEL_STORAGE_KEY, String(open));
  } catch {
    // Ignore storage errors.
  }
};

const closeCommandPalette = () => {
  const palette = useCommandPaletteStore.getState();
  if (palette.isOpen) {
    palette.closePalette();
  }
};

let nextNonce = 1;

export const useTaskNavigationStore = createWithEqualityFn<TaskNavigationStore>()(
  (set, get) => ({
    quickSwitcherOpen: false,
    globalSearchOpen: false,
    globalSearchInitialQuery: '',
    topicPanelOpen: loadTopicPanelOpen(),
    pendingActivation: null,
    pendingScroll: null,

    toggleQuickSwitcher: () => {
      const open = !get().quickSwitcherOpen;
      if (open) {
        closeCommandPalette();
      }
      set({ quickSwitcherOpen: open, globalSearchOpen: false });
    },
    closeQuickSwitcher: () => set({ quickSwitcherOpen: false }),
    openGlobalSearch: (initialQuery = '') => {
      closeCommandPalette();
      set({ globalSearchOpen: true, globalSearchInitialQuery: initialQuery, quickSwitcherOpen: false });
    },
    toggleGlobalSearch: () => {
      if (get().globalSearchOpen) {
        set({ globalSearchOpen: false });
      } else {
        get().openGlobalSearch();
      }
    },
    closeGlobalSearch: () => set({ globalSearchOpen: false }),
    toggleTopicPanel: () => {
      const open = !get().topicPanelOpen;
      saveTopicPanelOpen(open);
      set({ topicPanelOpen: open });
    },
    setTopicPanelOpen: (open) => {
      saveTopicPanelOpen(open);
      set({ topicPanelOpen: open });
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
