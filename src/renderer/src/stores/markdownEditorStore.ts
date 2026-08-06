import { create } from 'zustand';

type MarkdownEditorOverlayState = {
  isOpen: boolean;
  ownerId: string | null;
  closeHandler: (() => void) | null;
  open: (ownerId: string, closeHandler: () => void) => void;
  close: (ownerId: string) => void;
  requestClose: () => void;
};

// Global coordination store for the expanded markdown editor overlay.
// Lets any navigation owner (project/task/page switcher) force-close the
// overlay before the destination view paints, so the portal never lingers
// on a newly navigated page.
export const useMarkdownEditorOverlayStore = create<MarkdownEditorOverlayState>((set, get) => ({
  isOpen: false,
  ownerId: null,
  closeHandler: null,
  open: (ownerId, closeHandler) => set({ isOpen: true, ownerId, closeHandler }),
  // Only the owner may clear, so an unmounting inactive field can't wipe an active overlay's state.
  close: (ownerId) => set((state) => (state.ownerId === ownerId ? { isOpen: false, ownerId: null, closeHandler: null } : state)),
  requestClose: () => {
    const { isOpen, closeHandler } = get();
    if (isOpen && closeHandler) {
      closeHandler();
    }
  },
}));
