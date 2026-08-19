import fs from 'fs/promises';
import path from 'path';

import type { WorkflowLogData } from '@common/types';
import { fileExists } from '@common/node-utils';

import { AIDER_DESK_TASKS_DIR, AIDER_DESK_WORKFLOW_EVENTS_FILE } from '@/constants';
import logger from '@/logger';

export const MAX_LOADED_WORKFLOW_EVENTS = 2000;

export class WorkflowEventStore {
  private readonly filePath: string;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private lastSequence = 0;
  private appendChain: Promise<void> = Promise.resolve();

  constructor(projectDir: string, private readonly taskId: string) {
    this.filePath = path.join(projectDir, AIDER_DESK_TASKS_DIR, taskId, AIDER_DESK_WORKFLOW_EVENTS_FILE);
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** Cheap existence probe used by the lazy migration. */
  async exists(): Promise<boolean> {
    return fileExists(this.filePath);
  }

  async ready(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.load()
        .then((events) => {
          this.lastSequence = Math.max(0, ...events.map((event) => event.sequence));
          this.initialized = true;
        })
        .catch((error) => {
          logger.error('Failed to initialize workflow event store', { taskId: this.taskId, error });
          this.lastSequence = 0;
          this.initialized = true;
        });
    }
    await this.initPromise;
  }

  allocateSequence(): number {
    return ++this.lastSequence;
  }

  append(event: WorkflowLogData): Promise<void> {
    this.appendChain = this.appendChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
      })
      .catch((error) => {
        logger.error('Failed to append workflow event', { taskId: this.taskId, error });
      });
    return this.appendChain;
  }

  async load(): Promise<WorkflowLogData[]> {
    if (!(await fileExists(this.filePath))) return [];

    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      logger.error('Failed to load workflow events', { taskId: this.taskId, error });
      return [];
    }

    const eventsById = new Map<string, WorkflowLogData>();
    content.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as WorkflowLogData;
        if (
          typeof event.id !== 'string' ||
          typeof event.sequence !== 'number' ||
          typeof event.timestamp !== 'number' ||
          typeof event.message !== 'string'
        ) {
          throw new Error('invalid workflow event shape');
        }
        eventsById.set(event.id, event);
      } catch {
        logger.warn('Skipping malformed workflow event line', { taskId: this.taskId, lineNumber: index + 1 });
      }
    });

    const events = [...eventsById.values()]
      .sort((a, b) => a.sequence - b.sequence || a.timestamp - b.timestamp)
      .slice(-MAX_LOADED_WORKFLOW_EVENTS);

    this.lastSequence = Math.max(this.lastSequence, 0, ...events.map((event) => event.sequence));
    this.initialized = true;
    return events;
  }

  async copyFrom(source: WorkflowEventStore, options?: { untilTimestamp?: number }): Promise<void> {
    const events = (await source.load()).filter((event) => options?.untilTimestamp === undefined || event.timestamp <= options.untilTimestamp);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, events.map((event) => JSON.stringify(event)).join(events.length ? '\n' : '') + (events.length ? '\n' : ''), 'utf8');
    this.lastSequence = Math.max(0, ...events.map((event) => event.sequence));
    this.initialized = true;
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
    this.lastSequence = 0;
    this.initialized = true;
  }
}
