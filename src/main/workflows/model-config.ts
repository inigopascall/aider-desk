import {
  AgentProfile,
  WorkflowConfig,
  WORKFLOW_ARBITER_ROLE,
  WORKFLOW_REVIEWER_ROLES,
  isWorkflowAgentEnabled,
} from '@common/types';
import { extractProviderModel } from '@common/utils';
import type { Task } from '@/task';
import type { WorkflowDefinition } from './types';

/**
 * Resolves the active configuration for a given workflow on a task.
 * Returns the persisted workflow config from settings or an empty agentModels record.
 *
 * @param task The task running the workflow
 * @param workflow The workflow definition being executed
 * @returns The resolved WorkflowConfig
 */
export function resolveWorkflowConfig(task: Task, workflow: WorkflowDefinition): WorkflowConfig {
  return task.getProjectSettings().workflowConfigs?.[workflow.id] ?? { agentModels: {} };
}

/**
 * Validates that all configured primary and fallback models reference available LLM providers.
 *
 * @param task The task context with configured providers
 * @param config The workflow configuration to validate
 * @returns An array of error strings describing any unconfigured providers
 */
export function validateWorkflowConfig(task: Task, config: WorkflowConfig): string[] {
  const problems: string[] = [];

  for (const [role, { primary, fallback }] of Object.entries(config.agentModels)) {
    if (primary && primary.trim().length > 0) {
      const [providerId] = extractProviderModel(primary);
      if (!task.hasProvider(providerId)) {
        problems.push(`Agent '${role}': primary model provider '${providerId}' is not configured`);
      }
    }

    if (fallback && fallback.trim().length > 0) {
      const [providerId] = extractProviderModel(fallback);
      if (!task.hasProvider(providerId)) {
        problems.push(`Agent '${role}': fallback model provider '${providerId}' is not configured`);
      }
    }
  }

  return problems;
}

/**
 * Applies a primary or fallback model override to an agent profile.
 * When the slot is unset or empty, returns the agent profile unchanged.
 *
 * @param profile The base agent profile
 * @param roleName The name/role of the agent in the workflow
 * @param config The workflow configuration, if present
 * @param slot Whether to apply the 'primary' or 'fallback' model
 * @returns The updated agent profile with the overridden provider and model
 */
export function applyModelOverride(
  profile: AgentProfile,
  roleName: string,
  config: WorkflowConfig | undefined,
  slot: 'primary' | 'fallback',
): AgentProfile {
  const modelId = config?.agentModels?.[roleName]?.[slot];
  if (!modelId || modelId.trim().length === 0) {
    return profile;
  }

  const [provider, model] = extractProviderModel(modelId);
  return { ...profile, provider, model };
}

/**
 * Generates a human-readable summary of the model overrides and optional-agent
 * enablement in a workflow configuration.
 *
 * @param config The workflow configuration
 * @returns A string summary describing the configured overrides and optional agents
 */
export function describeWorkflowConfig(config: WorkflowConfig): string {
  let overrideCount = 0;

  for (const models of Object.values(config.agentModels)) {
    const hasPrimary = models?.primary && models.primary.trim().length > 0;
    const hasFallback = models?.fallback && models.fallback.trim().length > 0;
    if (hasPrimary || hasFallback) {
      overrideCount++;
    }
  }

  const summary: string[] = [
    overrideCount === 0 ? 'Agent profile defaults' : `${overrideCount} role model override(s)`,
    `Arbiter: ${isWorkflowAgentEnabled(config, WORKFLOW_ARBITER_ROLE) ? 'on' : 'off'}`,
  ];

  const enabledReviewers = WORKFLOW_REVIEWER_ROLES.filter((role) => isWorkflowAgentEnabled(config, role));
  if (enabledReviewers.length > 0) {
    summary.push(`Reviewers: ${enabledReviewers.join(', ')}`);
  }

  return summary.join(' · ');
}
