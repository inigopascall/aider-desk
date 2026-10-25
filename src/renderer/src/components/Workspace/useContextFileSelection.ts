import { ContextManifestEntry, ContextManifestSection, ContextSectionId, TaskContextManifest } from '@common/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '@/contexts/ApiContext';
import { updateTaskState, useTaskStore } from '@/stores/taskStore';
import { showErrorNotification } from '@/utils/notifications';

// UI state for a manifest entry whose selection was changed by a click and is not yet confirmed by the
// backend. `opId` is the click that owns the entry; `settled` is set once that click's request has succeeded.
type PendingSelection = {
  selected: boolean;
  opId: number;
  settled: boolean;
};

type PendingState = {
  scope: string;
  selections: Map<string, PendingSelection>;
};

const NO_PENDING_SELECTIONS = new Map<string, PendingSelection>();

const noop = () => undefined;

const getScope = (baseDir: string, taskId: string) => `${baseDir}\u0000${taskId}`;

const getSelectionKey = (section: ContextSectionId, path: string) => `${section}\u0000${path}`;

// True when the stored manifest already shows every given path of the section in the requested state.
// Paths no longer in the section count as matching.
const manifestMatches = (taskId: string, section: ContextSectionId, paths: string[], selected: boolean): boolean => {
  const entries =
    useTaskStore
      .getState()
      .taskStateMap.get(taskId)
      ?.contextManifest?.sections.find((candidate) => candidate.id === section)?.entries ?? [];
  return paths.every((path) => {
    const entry = entries.find((candidate) => candidate.path === path);
    return !entry || entry.selected === selected;
  });
};

// Overlays pending selections on a section. A newly ticked entry borrows the delivery of an entry that is
// already selected in the same section until the next manifest reports the real value.
const applyPendingSelections = (section: ContextManifestSection, selections: Map<string, PendingSelection>): ContextManifestSection => {
  const selectedSample = section.entries.find((entry) => entry.selected);
  let changed = false;
  const entries = section.entries.map((entry): ContextManifestEntry => {
    const pending = selections.get(getSelectionKey(section.id, entry.path));
    if (!pending || pending.selected === entry.selected) {
      return entry;
    }
    changed = true;
    if (!pending.selected) {
      return { ...entry, selected: false, delivery: 'none', notSentReason: 'unselected' };
    }
    return { ...entry, selected: true, delivery: selectedSample?.delivery ?? 'content', notSentReason: selectedSample?.notSentReason };
  });
  return changed ? { ...section, entries } : section;
};

export type SetContextFileSelection = (section: ContextSectionId, paths: string[], selected: boolean) => void;

export const useContextFileSelection = (
  baseDir: string,
  taskId: string,
  manifest: TaskContextManifest | null,
): { sections: ContextManifestSection[]; setSelection: SetContextFileSelection } => {
  const api = useApi();
  const scope = getScope(baseDir, taskId);
  const [pendingState, setPendingState] = useState<PendingState>(() => ({ scope, selections: new Map() }));
  const pendingSelections = pendingState.scope === scope ? pendingState.selections : NO_PENDING_SELECTIONS;
  const nextOpIdRef = useRef(0);
  const requestChainRef = useRef<Promise<void>>(Promise.resolve());

  const sections = useMemo(() => {
    const manifestSections = manifest?.sections ?? [];
    if (pendingSelections.size === 0) {
      return manifestSections;
    }
    return manifestSections.map((section) => applyPendingSelections(section, pendingSelections));
  }, [manifest, pendingSelections]);

  // Sends backend requests one at a time, in click order, so the last click is also the final backend state.
  const enqueueRequest = useCallback((request: () => Promise<void>): Promise<void> => {
    const result = requestChainRef.current.then(request);
    requestChainRef.current = result.then(noop, noop);
    return result;
  }, []);

  const requestManifest = useCallback(() => {
    void enqueueRequest(async () => {
      const latest = await api.getTaskContextManifest(baseDir, taskId);
      updateTaskState(taskId, { contextManifest: latest });
    }).catch(noop);
  }, [api, baseDir, taskId, enqueueRequest]);

  const setSelection = useCallback<SetContextFileSelection>(
    (section, paths, selected) => {
      if (paths.length === 0) {
        return;
      }
      const keys = paths.map((path) => getSelectionKey(section, path));
      const opScope = getScope(baseDir, taskId);
      const opId = ++nextOpIdRef.current;

      // Show the new state immediately. A later click on the same entry takes over its pending state.
      setPendingState((prev) => {
        const selections = new Map<string, PendingSelection>(prev.scope === opScope ? prev.selections : []);
        for (const key of keys) {
          selections.set(key, { selected, opId, settled: false });
        }
        return { scope: opScope, selections };
      });

      // Clears or settles the entries this click still owns. Entries taken over by a later click are left alone.
      const releaseOwnedEntries = (release: 'clear' | 'settle') => {
        setPendingState((prev) => {
          if (prev.scope !== opScope) {
            return prev;
          }
          let selections: Map<string, PendingSelection> | null = null;
          for (const key of keys) {
            const entry = prev.selections.get(key);
            if (!entry || entry.opId !== opId) {
              continue;
            }
            if (!selections) {
              selections = new Map(prev.selections);
            }
            if (release === 'clear') {
              selections.delete(key);
            } else {
              selections.set(key, { ...entry, settled: true });
            }
          }
          return selections ? { scope: opScope, selections } : prev;
        });
      };

      void enqueueRequest(() => api.setTaskFileSelection(baseDir, taskId, section, paths, selected)).then(
        () => {
          if (manifestMatches(taskId, section, paths, selected)) {
            releaseOwnedEntries('clear');
          } else {
            // The confirming manifest has not arrived yet; keep showing the new state until it does.
            releaseOwnedEntries('settle');
            requestManifest();
          }
        },
        (error: unknown) => {
          releaseOwnedEntries('clear');
          showErrorNotification(error instanceof Error ? error.message : String(error));
          requestManifest();
        },
      );
    },
    [api, baseDir, taskId, enqueueRequest, requestManifest],
  );

  // Once a click's request has succeeded, the next manifest from the backend is authoritative for its entries.
  useEffect(
    () =>
      useTaskStore.subscribe((state, prevState) => {
        if (state.taskStateMap.get(taskId)?.contextManifest === prevState.taskStateMap.get(taskId)?.contextManifest) {
          return;
        }
        setPendingState((prev) => {
          if (prev.scope !== scope) {
            return prev;
          }
          let selections: Map<string, PendingSelection> | null = null;
          for (const [key, entry] of prev.selections) {
            if (!entry.settled) {
              continue;
            }
            if (!selections) {
              selections = new Map(prev.selections);
            }
            selections.delete(key);
          }
          return selections ? { scope, selections } : prev;
        });
      }),
    [scope, taskId],
  );

  return { sections, setSelection };
};
