import { ipcMain } from 'electron';
import { TopicCompactionOptions, TopicCompactionTarget } from '@common/types';

import { requireTaskNavigationManager } from './instance';

export const setupTaskNavigationIpcHandlers = (): void => {
  ipcMain.handle('task-navigation-search', async (_, query: string, limit?: number) => requireTaskNavigationManager().search(query, limit));

  ipcMain.handle('task-navigation-index-status', async () => requireTaskNavigationManager().getStatus());

  ipcMain.handle('task-navigation-rebuild-index', async () => requireTaskNavigationManager().rebuildIndex());

  ipcMain.handle('task-navigation-regenerate-summary', async (_, baseDir: string, taskId: string) =>
    requireTaskNavigationManager().regenerateTaskSummary(baseDir, taskId),
  );

  ipcMain.handle('task-navigation-compaction-preview', async (_, baseDir: string, taskId: string, target: TopicCompactionTarget) =>
    requireTaskNavigationManager().previewTopicCompaction(baseDir, taskId, target),
  );

  ipcMain.handle(
    'task-navigation-compaction-compact',
    async (_, baseDir: string, taskId: string, target: TopicCompactionTarget, options: TopicCompactionOptions) =>
      requireTaskNavigationManager().compactTopic(baseDir, taskId, target, options),
  );

  ipcMain.handle('task-navigation-compaction-undo', async (_, baseDir: string, taskId: string, compactionId: string) =>
    requireTaskNavigationManager().undoTopicCompaction(baseDir, taskId, compactionId),
  );

  ipcMain.handle('task-navigation-compaction-restore-archive', async (_, baseDir: string, taskId: string, archiveId: string) =>
    requireTaskNavigationManager().restoreCompactionArchive(baseDir, taskId, archiveId),
  );
};
