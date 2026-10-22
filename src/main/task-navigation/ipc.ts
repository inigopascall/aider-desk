import { ipcMain } from 'electron';

import { requireTaskNavigationManager } from './instance';

export const setupTaskNavigationIpcHandlers = (): void => {
  ipcMain.handle('task-navigation-search', async (_, query: string, limit?: number) => requireTaskNavigationManager().search(query, limit));

  ipcMain.handle('task-navigation-index-status', async () => requireTaskNavigationManager().getStatus());

  ipcMain.handle('task-navigation-rebuild-index', async () => requireTaskNavigationManager().rebuildIndex());

  ipcMain.handle('task-navigation-regenerate-summary', async (_, baseDir: string, taskId: string) =>
    requireTaskNavigationManager().regenerateTaskSummary(baseDir, taskId),
  );
};
