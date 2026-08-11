import { create } from 'zustand';

interface SnapshotModeState {
  snapshotTaskIds: Set<string>;
  toggleSnapshotMode: (taskId: string) => void;
  setSnapshotMode: (taskId: string, enabled: boolean) => void;
}

export const useSnapshotModeStore = create<SnapshotModeState>((set) => ({
  snapshotTaskIds: new Set<string>(),
  toggleSnapshotMode: (taskId: string) =>
    set((state) => {
      const newSet = new Set(state.snapshotTaskIds);
      if (newSet.has(taskId)) {
        newSet.delete(taskId);
      } else {
        newSet.add(taskId);
      }
      return { snapshotTaskIds: newSet };
    }),
  setSnapshotMode: (taskId: string, enabled: boolean) =>
    set((state) => {
      const newSet = new Set(state.snapshotTaskIds);
      if (enabled) {
        newSet.add(taskId);
      } else {
        newSet.delete(taskId);
      }
      return { snapshotTaskIds: newSet };
    }),
}));
