import { AgentProfile, DEFAULT_WORKFLOW_MODEL_SET_ID, WorkflowModelSet } from '@common/types';
import { extractProviderModel } from '@common/utils';
import { buildDefaultWorkflowModelSet } from '@common/agent';

import type { Task } from '@/task';
import type { WorkflowDefinition } from './types';

/**
 * Resolves the active model set for a given workflow on a given task.
 * Precedence: task-level override → project-level default → the workflow's
 * built-in "Default" set (id === DEFAULT_WORKFLOW_MODEL_SET_ID).
 * "Default" is synthesized live from the workflow agents' own configured
 * provider/model whenever it hasn't been customized (persisted) yet.
 */
export function resolveActiveModelSet(task: Task, workflow: WorkflowDefinition): WorkflowModelSet {
  const settings = task.getSettings();
  const projectSettings = task.getProject().getProjectSettings();

  const taskSetId = task.task.workflowModelSetIds?.[workflow.id];
  const projectSetId = projectSettings.workflowModelSetIds?.[workflow.id];
  const setId = taskSetId ?? projectSetId ?? DEFAULT_WORKFLOW_MODEL_SET_ID;

  const sets = settings.workflowModelSets?.[workflow.id] ?? [];
  const found = sets.find((s) => s.id === setId);
  if (found) {
    return found;
  }

  if (setId !== DEFAULT_WORKFLOW_MODEL_SET_ID) {
    task.addLogMessage(
      'warning',
      `Workflow model set '${setId}' not found for workflow '${workflow.id}'. Using default agent profile models.`,
    );
  }

  return buildDefaultWorkflowModelSet(workflow.agents, task.getProject().getWorkflowAgentProfiles());
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
export function describeModelSet(set: WorkflowModelSet): string {
  return set.name;
}

/**
 * Applies an ephemeral provider/model override to an in-memory agent profile.
 * This never mutates or persists the stored workflow-agent profile.
 */
export function applyModelIdToProfile(profile: AgentProfile, modelId?: string): AgentProfile {
  if (!modelId || modelId.trim().length === 0) return profile;
  const [provider, model] = extractProviderModel(modelId);
  return { ...profile, provider, model };
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
  return applyModelIdToProfile(profile, set?.models[roleName]);
}
