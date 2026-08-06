import { ContextFile } from '@common/types';
import { createWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/vanilla/shallow';
import { devtools } from 'zustand/middleware';

interface ContextFilesClipboardState {
  copiedFiles: ContextFile[];
  sourceBaseDir: string | null;
  copy: (files: ContextFile[], sourceBaseDir: string) => void;
  clear: () => void;
}

const DEVTOOLS_OPTIONS = {
  name: 'ContextFilesClipboardStore',
  enabled: import.meta.env.DEV,
};

/**
 * Holds the context files copied from a task so they can be pasted into
 * another task (or project). The clipboard persists across task/project/page
 * switches and is only overwritten by the next copy, enabling multi-paste.
 */
export const useContextFilesClipboard = createWithEqualityFn<ContextFilesClipboardState>()(
  devtools(
    (set) => ({
      copiedFiles: [],
      sourceBaseDir: null,

      copy: (files, sourceBaseDir) =>
        set({
          copiedFiles: [...files],
          sourceBaseDir,
        }),

      clear: () =>
        set({
          copiedFiles: [],
          sourceBaseDir: null,
        }),
    }),
    DEVTOOLS_OPTIONS,
  ),
  shallow,
);

/**
 * Selector hook that reports whether any files are currently on the clipboard.
 * Returns a boolean so components only re-render when the value flips.
 */
export const useHasCopiedFiles = (): boolean => useContextFilesClipboard((s) => s.copiedFiles.length > 0);
