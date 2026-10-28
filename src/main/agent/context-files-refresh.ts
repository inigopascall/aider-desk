import path from 'path';

import type { ContextFile } from '@common/types';

/** Identity of a context file for change detection: its normalised path and whether it is read-only. */
export const getContextFileKey = (file: ContextFile): string => `${path.normalize(file.path)}\u0000${file.readOnly ? 'ro' : 'rw'}`;

/** Files present in `current` but not `previous` (added), and the reverse (removed). A read-only toggle shows up in both. */
export const diffContextFiles = (previous: ContextFile[], current: ContextFile[]): { added: ContextFile[]; removed: ContextFile[] } => {
  const previousKeys = new Set(previous.map(getContextFileKey));
  const currentKeys = new Set(current.map(getContextFileKey));
  return {
    added: current.filter((file) => !previousKeys.has(getContextFileKey(file))),
    removed: previous.filter((file) => !currentKeys.has(getContextFileKey(file))),
  };
};

/**
 * The note shown to the model when the context files change during a run, or null when there is nothing to say.
 * A file in both lists (a read-only toggle) is reported as added only.
 */
export const buildContextFilesUpdateNote = (added: ContextFile[], removed: ContextFile[], includesContents: boolean): string | null => {
  const addedPaths = new Set(added.map((file) => path.normalize(file.path)));
  const removedOnly = removed.filter((file) => !addedPaths.has(path.normalize(file.path)));
  if (added.length === 0 && removedOnly.length === 0) {
    return null;
  }
  const lines: string[] = ['The working context files changed while you were working.'];
  if (added.length > 0) {
    lines.push('', includesContents ? 'Added or changed (their current contents follow):' : 'Added or changed:');
    lines.push(...added.map((file) => `- ${file.path}${file.readOnly ? ' (read-only)' : ''}`));
  }
  if (removedOnly.length > 0) {
    lines.push('', 'Removed (disregard any earlier contents of these files):');
    lines.push(...removedOnly.map((file) => `- ${file.path}`));
  }
  return lines.join('\n');
};
