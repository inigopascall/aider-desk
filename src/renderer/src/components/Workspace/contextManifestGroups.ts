import type { ContextManifestEntry } from '@common/types';
import type { TriState } from '@/components/common/TriStateCheckbox';

export type ContextEntryGroup = {
  key: string;
  label: string;
  entries: ContextManifestEntry[];
};

const ROOT_GROUP_LABEL = './';

const splitDisplayPath = (displayPath: string): { dir: string; name: string } => {
  const index = displayPath.lastIndexOf('/');
  if (index === -1) {
    return { dir: '', name: displayPath };
  }
  return { dir: index === 0 ? '/' : displayPath.slice(0, index), name: displayPath.slice(index + 1) };
};

export const getEntryFileName = (entry: ContextManifestEntry): string => splitDisplayPath(entry.displayPath).name;

// Groups entries by the folder part of their display path. Groups keep the order of their first entry,
// and entries keep manifest order inside their group.
export const groupEntriesByFolder = (entries: ContextManifestEntry[]): ContextEntryGroup[] => {
  const groups: ContextEntryGroup[] = [];
  const groupsByDir = new Map<string, ContextEntryGroup>();
  for (const entry of entries) {
    const { dir } = splitDisplayPath(entry.displayPath);
    let group = groupsByDir.get(dir);
    if (!group) {
      group = { key: dir, label: dir === '' ? ROOT_GROUP_LABEL : dir, entries: [] };
      groupsByDir.set(dir, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
};

export const getSelectionState = (entries: ContextManifestEntry[]): TriState => {
  const selectedCount = entries.filter((entry) => entry.selected).length;
  if (selectedCount === 0) {
    return 'unchecked';
  }
  return selectedCount === entries.length ? 'checked' : 'indeterminate';
};
