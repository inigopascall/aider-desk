import { Response, Router } from 'express';
import { z } from 'zod';

import { getTaskNavigationManager } from './instance';

import type { TaskNavigationManager } from './task-navigation-manager';

import { BaseApi } from '@/server/rest-api/base-api';

const SearchSchema = z.object({
  query: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const RegenerateSummarySchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task id is required'),
});

/** REST endpoints for global task search and topic maps. */
export class TaskNavigationApi extends BaseApi {
  constructor() {
    super();
  }

  private requireManager(res: Response): TaskNavigationManager | null {
    const manager = getTaskNavigationManager();
    if (!manager) {
      res.status(503).json({ error: 'Task navigation is not initialised' });
      return null;
    }
    return manager;
  }

  registerRoutes(router: Router): void {
    router.get(
      '/task-navigation/search',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(SearchSchema, req.query, res);
        if (!parsed) {
          return;
        }
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        res.status(200).json(await manager.search(parsed.query, parsed.limit));
      }),
    );

    router.get(
      '/task-navigation/index-status',
      this.handleRequest(async (_req, res) => {
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        res.status(200).json(manager.getStatus());
      }),
    );

    router.post(
      '/task-navigation/rebuild-index',
      this.handleRequest(async (_req, res) => {
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        res.status(200).json(await manager.rebuildIndex());
      }),
    );

    router.post(
      '/task-navigation/regenerate-summary',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(RegenerateSummarySchema, req.body, res);
        if (!parsed) {
          return;
        }
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        res.status(200).json(await manager.regenerateTaskSummary(parsed.projectDir, parsed.taskId));
      }),
    );
  }
}
