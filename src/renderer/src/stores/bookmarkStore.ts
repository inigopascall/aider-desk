import { create } from 'zustand';

// Bookmark store implementation
// Persisted localStorage bookmarks, toggle/clear/prune actions,
// module-level action functions, and useTaskBookmarks/useIsBookmarked hooks.

export interface Bookmark {
  id: string;
  label: string;
  createdAt: number;
}

interface BookmarkState {
  bookmarks: Record<string, Bookmark>;
  addBookmark: (id: string, label: string) => void;
  removeBookmark: (id: string) => void;
  toggleBookmark: (id: string, label: string) => void;
  clearBookmarks: () => void;
  pruneBookmarks: (validIds: Set<string>) => void;
  isBookmarked: (id: string) => boolean;
  getBookmark: (id: string) => Bookmark | undefined;
  getAllBookmarks: () => Bookmark[];
}

const STORAGE_KEY = 'aider-desk-bookmarks';

const loadBookmarks = (): Record<string, Bookmark> => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to parse bookmarks from localStorage', e);
  }
  return {};
};

const saveBookmarks = (bookmarks: Record<string, Bookmark>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch (e) {
    console.warn('Failed to save bookmarks to localStorage', e);
  }
};

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: loadBookmarks(),
  addBookmark: (id, label) => {
    const bookmark: Bookmark = {
      id,
      label,
      createdAt: Date.now(),
    };
    set((state) => {
      const updated = { ...state.bookmarks, [id]: bookmark };
      saveBookmarks(updated);
      return { bookmarks: updated };
    });
  },
  removeBookmark: (id) => {
    set((state) => {
      const updated = { ...state.bookmarks };
      delete updated[id];
      saveBookmarks(updated);
      return { bookmarks: updated };
    });
  },
  toggleBookmark: (id, label) => {
    const { isBookmarked, addBookmark, removeBookmark } = get();
    if (isBookmarked(id)) {
      removeBookmark(id);
    } else {
      addBookmark(id, label);
    }
  },
  clearBookmarks: () => {
    saveBookmarks({});
    set({ bookmarks: {} });
  },
  pruneBookmarks: (validIds) => {
    set((state) => {
      const updated: Record<string, Bookmark> = {};
      Object.keys(state.bookmarks).forEach((key) => {
        if (validIds.has(key)) {
          updated[key] = state.bookmarks[key];
        }
      });
      saveBookmarks(updated);
      return { bookmarks: updated };
    });
  },
  isBookmarked: (id) => {
    return id in get().bookmarks;
  },
  getBookmark: (id) => {
    return get().bookmarks[id];
  },
  getAllBookmarks: () => {
    return Object.values(get().bookmarks);
  },
}));

// Module-level action functions
export const addBookmark = (id: string, label: string) =>
  useBookmarkStore.getState().addBookmark(id, label);

export const removeBookmark = (id: string) =>
  useBookmarkStore.getState().removeBookmark(id);

export const toggleBookmark = (id: string, label: string) =>
  useBookmarkStore.getState().toggleBookmark(id, label);

export const clearBookmarks = () =>
  useBookmarkStore.getState().clearBookmarks();

export const pruneBookmarks = (validIds: Set<string>) =>
  useBookmarkStore.getState().pruneBookmarks(validIds);

export const isBookmarked = (id: string) =>
  useBookmarkStore.getState().isBookmarked(id);

// Hooks
export const useTaskBookmarks = () => {
  return useBookmarkStore((state) => state.getAllBookmarks());
};

export const useIsBookmarked = (id: string) => {
  return useBookmarkStore((state) => state.isBookmarked(id));
};
