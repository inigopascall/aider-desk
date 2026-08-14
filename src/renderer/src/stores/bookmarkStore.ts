import { useShallow } from 'zustand/react/shallow';
import { createWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/vanilla/shallow';
import { devtools } from 'zustand/middleware';

export interface Bookmark {
  /** Message id this bookmark points at. */
  id: string;
  /** Snapshot of the message title at bookmark time. */
  label: string;
  createdAt: number;
}

/** messageId -> Bookmark */
export type TaskBookmarks = Record<string, Bookmark>;

interface BookmarkState {
  /** taskId -> TaskBookmarks */
  bookmarksByTask: Record<string, TaskBookmarks>;

  addBookmark: (taskId: string, messageId: string, label: string) => void;
  removeBookmark: (taskId: string, messageId: string) => void;
  toggleBookmark: (taskId: string, messageId: string, label: string) => void;
  clearTaskBookmarks: (taskId: string) => void;
  pruneTaskBookmarks: (taskId: string, validMessageIds: Set<string>) => void;
}

const STORAGE_KEY = 'aider-desk-bookmarks-v2';
const EMPTY_TASK_BOOKMARKS: TaskBookmarks = {};

const DEVTOOLS_OPTIONS = {
  name: 'BookmarkStore',
  enabled: import.meta.env.DEV,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const loadBookmarks = (): Record<string, TaskBookmarks> => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return {};
    }

    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || !Object.values(parsed).every(isRecord)) {
      return {};
    }

    return parsed as Record<string, TaskBookmarks>;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Failed to parse bookmarks from localStorage', error);
    return {};
  }
};

const saveBookmarks = (value: Record<string, TaskBookmarks>): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Failed to save bookmarks to localStorage', error);
  }
};

export const useBookmarkStore = createWithEqualityFn<BookmarkState>()(
  devtools(
    (set, get) => ({
      bookmarksByTask: loadBookmarks(),

      addBookmark: (taskId, messageId, label) =>
        set((state) => {
          const bookmarksByTask = {
            ...state.bookmarksByTask,
            [taskId]: {
              ...state.bookmarksByTask[taskId],
              [messageId]: {
                id: messageId,
                label,
                createdAt: Date.now(),
              },
            },
          };
          saveBookmarks(bookmarksByTask);
          return { bookmarksByTask };
        }),

      removeBookmark: (taskId, messageId) =>
        set((state) => {
          const taskBookmarks = state.bookmarksByTask[taskId];
          if (!taskBookmarks?.[messageId]) {
            return state;
          }

          const { [messageId]: _, ...remainingBookmarks } = taskBookmarks;
          const { [taskId]: __, ...otherTasks } = state.bookmarksByTask;
          const bookmarksByTask =
            Object.keys(remainingBookmarks).length > 0
              ? { ...otherTasks, [taskId]: remainingBookmarks }
              : otherTasks;

          saveBookmarks(bookmarksByTask);
          return { bookmarksByTask };
        }),

      toggleBookmark: (taskId, messageId, label) => {
        if (get().bookmarksByTask[taskId]?.[messageId]) {
          get().removeBookmark(taskId, messageId);
        } else {
          get().addBookmark(taskId, messageId, label);
        }
      },

      clearTaskBookmarks: (taskId) =>
        set((state) => {
          if (!state.bookmarksByTask[taskId]) {
            return state;
          }

          const { [taskId]: _, ...bookmarksByTask } = state.bookmarksByTask;
          saveBookmarks(bookmarksByTask);
          return { bookmarksByTask };
        }),

      pruneTaskBookmarks: (taskId, validMessageIds) =>
        set((state) => {
          const taskBookmarks = state.bookmarksByTask[taskId];
          if (!taskBookmarks) {
            return state;
          }

          const retainedBookmarks = Object.fromEntries(Object.entries(taskBookmarks).filter(([messageId]) => validMessageIds.has(messageId))) as TaskBookmarks;
          if (Object.keys(retainedBookmarks).length === Object.keys(taskBookmarks).length) {
            return state;
          }

          const { [taskId]: _, ...otherTasks } = state.bookmarksByTask;
          const bookmarksByTask =
            Object.keys(retainedBookmarks).length > 0
              ? { ...otherTasks, [taskId]: retainedBookmarks }
              : otherTasks;

          saveBookmarks(bookmarksByTask);
          return { bookmarksByTask };
        }),
    }),
    DEVTOOLS_OPTIONS,
  ),
  shallow,
);

export const addBookmark = (taskId: string, messageId: string, label: string) => useBookmarkStore.getState().addBookmark(taskId, messageId, label);

export const removeBookmark = (taskId: string, messageId: string) => useBookmarkStore.getState().removeBookmark(taskId, messageId);

export const toggleBookmark = (taskId: string, messageId: string, label: string) => useBookmarkStore.getState().toggleBookmark(taskId, messageId, label);

export const clearTaskBookmarks = (taskId: string) => useBookmarkStore.getState().clearTaskBookmarks(taskId);

export const pruneTaskBookmarks = (taskId: string, validMessageIds: Set<string>) => useBookmarkStore.getState().pruneTaskBookmarks(taskId, validMessageIds);

export const useIsBookmarked = (taskId: string | undefined, messageId: string): boolean =>
  useBookmarkStore((state) => (taskId ? messageId in (state.bookmarksByTask[taskId] ?? {}) : false));

export const useTaskBookmarks = (taskId: string | undefined): TaskBookmarks =>
  useBookmarkStore(useShallow((state) => (taskId ? (state.bookmarksByTask[taskId] ?? EMPTY_TASK_BOOKMARKS) : EMPTY_TASK_BOOKMARKS)));
