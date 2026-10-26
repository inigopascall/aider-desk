import { Response, Router } from 'express';
import { z } from 'zod';

import { getTaskNavigationManager } from './instance';
import { TopicCompactionError } from './topic-compaction';

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

const CompactionTargetSchema = z.object({
  topicIndex: z.number().int().min(0),
  sectionIndex: z.number().int().min(0).optional(),
  firstMessageId: z.string().min(1, 'First message id is required'),
});

const CompactionPreviewSchema = RegenerateSummarySchema.extend({
  target: CompactionTargetSchema,
});

const CompactTopicSchema = CompactionPreviewSchema.extend({
  options: z.object({
    level: z.number().int().min(1).max(5),
    instructions: z.string().optional(),
  }),
});

const UndoCompactionSchema = RegenerateSummarySchema.extend({
  compactionId: z.string().min(1, 'Compaction id is required'),
});

const RestoreArchiveSchema = RegenerateSummarySchema.extend({
  archiveId: z.string().min(1, 'Archive id is required'),
});

/** REST endpoints for global task search, topic maps and topic compaction. */
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

  /** Sends the result of a compaction call; a refusal becomes HTTP 409 with its reason-prefixed message. */
  private async respondToCompaction(res: Response, work: () => Promise<unknown>): Promise<void> {
    try {
      res.status(200).json(await work());
    } catch (error) {
      if (error instanceof TopicCompactionError) {
        res.status(409).json({ error: error.message, details: error.message });
        return;
      }
      throw error;
    }
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

    router.post(
      '/task-navigation/regenerate-title',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(RegenerateSummarySchema, req.body, res);
        if (!parsed) {
          return;
        }
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        res.status(200).json(await manager.regenerateTaskTitle(parsed.projectDir, parsed.taskId));
      }),
    );

    router.post(
      '/task-navigation/compaction/preview',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(CompactionPreviewSchema, req.body, res);
        if (!parsed) {
          return;
        }
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        await this.respondToCompaction(res, () => manager.previewTopicCompaction(parsed.projectDir, parsed.taskId, parsed.target));
      }),
    );

    router.post(
      '/task-navigation/compaction/compact',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(CompactTopicSchema, req.body, res);
        if (!parsed) {
          return;
        }
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        await this.respondToCompaction(res, () => manager.compactTopic(parsed.projectDir, parsed.taskId, parsed.target, parsed.options));
      }),
    );

    router.post(
      '/task-navigation/compaction/undo',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(UndoCompactionSchema, req.body, res);
        if (!parsed) {
          return;
        }
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        await this.respondToCompaction(res, () => manager.undoTopicCompaction(parsed.projectDir, parsed.taskId, parsed.compactionId));
      }),
    );

    router.post(
      '/task-navigation/compaction/restore-archive',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(RestoreArchiveSchema, req.body, res);
        if (!parsed) {
          return;
        }
        const manager = this.requireManager(res);
        if (!manager) {
          return;
        }
        await this.respondToCompaction(res, () => manager.restoreCompactionArchive(parsed.projectDir, parsed.taskId, parsed.archiveId));
      }),
    );
  }
}
