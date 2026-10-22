import { TASK_NAVIGATION_METADATA_KEYS, TaskData } from '@common/types';

/** Metadata keys owned by the main process: values sent by the user interface are replaced by the current ones. */
const MANAGED_METADATA_KEYS: string[] = [
  TASK_NAVIGATION_METADATA_KEYS.taskNumber,
  TASK_NAVIGATION_METADATA_KEYS.taskSummary,
  TASK_NAVIGATION_METADATA_KEYS.lastMessagePreview,
];
const GENERATING_NAME = '<<generating>>';

/**
 * Adjusts a task update coming from the user interface or the REST API:
 * - a manual rename locks the title, so topic maps no longer rename the task;
 * - task numbers, topic maps and previews in a metadata update are replaced by the current values, so a stale copy of
 *   the metadata cannot roll them back;
 * - a metadata update that does not mention the title lock keeps the current lock.
 */
export const prepareTaskNavigationUpdate = (current: TaskData, updates: Partial<TaskData>): Partial<TaskData> => {
  const renamed = typeof updates.name === 'string' && updates.name.trim() !== '' && updates.name !== current.name && updates.name !== GENERATING_NAME;
  if (!renamed && updates.metadata === undefined) {
    return updates;
  }

  const currentMetadata = current.metadata ?? {};
  const metadata: Record<string, unknown> = { ...(updates.metadata ?? currentMetadata) };
  for (const key of MANAGED_METADATA_KEYS) {
    if (key in currentMetadata) {
      metadata[key] = currentMetadata[key];
    } else {
      delete metadata[key];
    }
  }

  const lockKey = TASK_NAVIGATION_METADATA_KEYS.nameLocked;
  if (updates.metadata && !(lockKey in updates.metadata) && lockKey in currentMetadata) {
    metadata[lockKey] = currentMetadata[lockKey];
  }
  if (renamed) {
    metadata[lockKey] = true;
  }

  return { ...updates, metadata };
};
