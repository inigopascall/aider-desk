import { AgentProfile, WorkflowModelSet } from '@common/types';
import { extractProviderModel } from '@common/utils';

import type { Task } from '@/task';

/**
 * Resolves the active model set for a given workflow on a given task.
 * Precedence: task-level override → project-level default → none.
 * Returns undefined when no set is selected or the referenced set no longer exists.
 */
export function resolveActiveModelSet(task: Task, workflowId: string): WorkflowModelSet | undefined {
  const settings = task.getSettings();
  const projectSettings = task.getProject().getProjectSettings();

  const taskSetId = task.task.workflowModelSetIds?.[workflowId];
  const projectSetId = projectSettings.workflowModelSetIds?.[workflowId];
  const setId = taskSetId ?? projectSetId;

  if (!setId) return undefined;

  const sets = settings.workflowModelSets?.[workflowId] ?? [];
  const found = sets.find((s) => s.id === setId);

  if (!found) {
    task.addLogMessage(
      'warning',
      `Workflow model set '${setId}' not found for workflow '${workflowId}'. Using default agent profile models.`,
    );
  }

  return found;
}

/**
 * Validates that every model reference in a set points to a configured provider.
 * Returns an array of problem strings (empty = valid).
 */
export function validateModelSet(task: Task, set: WorkflowModelSet): string[] {
  const problems: string[] = [];
  for (const [role, modelId] of Object.entries(set.models)) {
    if (!modelId || modelId.trim().length === 0) continue;
    const [providerId] = extractProviderModel(modelId);
    if (!task.hasProvider(providerId)) {
      problems.push(`Agent '${role}': provider '${providerId}' is not configured`);
    }
  }
  return problems;
}

/**
 * Returns a human-readable description for log messages.
 */
export function describeModelSet(set?: WorkflowModelSet): string {
  if (!set) return 'Default (agent profile models)';
  return set.name;
}

/**
 * Shallow-overrides provider and model on a resolved agent profile.
 * Returns the original profile unchanged when no override is in force
 * or when the set has no model entry for the given role.
 */
export function applyModelSetToProfile(
  profile: AgentProfile,
  roleName: string,
  set?: WorkflowModelSet,
): AgentProfile {
  if (!set) return profile;
  const modelId = set.models[roleName];
  if (!modelId || modelId.trim().length === 0) return profile;
  const [provider, model] = extractProviderModel(modelId);
  return { ...profile, provider, model };
}