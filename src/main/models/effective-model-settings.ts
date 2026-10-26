import type { AgentProfile, EffectiveModelSettings, EffectiveReasoning, EffectiveTemperature, Model, Reasoning, TaskData } from '@common/types';

export type TaskModelOverrides = Pick<TaskData, 'reasoningOverride' | 'temperatureOverride'>;

export type EffectiveModelSettingsInput = {
  /** The profile the agent runs with, carrying the provider and model in use. */
  profile: AgentProfile;
  /** The id of the task's own main agent profile. */
  taskAgentProfileId?: string | null;
  overrides?: TaskModelOverrides | null;
  /** The Model Library entry for the profile's provider and model. */
  model?: Model;
  /** The provider strategy's call parameters for a reasoning level. */
  getProviderParameters: (reasoning?: Reasoning) => Record<string, unknown>;
};

/** Task overrides apply only to the task's own main agent: never to sub-agents, workflow agents or internal agents. */
export const isTaskMainAgent = (profile: AgentProfile, taskAgentProfileId?: string | null): boolean =>
  !profile.isSubagent && !!taskAgentProfileId && profile.id === taskAgentProfileId;

/** Reasoning: the task override, then the agent profile, then the provider default. */
export const resolveEffectiveReasoning = (
  profile: AgentProfile,
  overrides: TaskModelOverrides | null | undefined,
  applyOverrides: boolean,
): EffectiveReasoning => {
  if (applyOverrides && overrides?.reasoningOverride) {
    return { value: overrides.reasoningOverride, source: 'task' };
  }
  if (profile.reasoning) {
    return { value: profile.reasoning, source: 'agent-profile' };
  }
  return { value: 'provider-default', source: 'default' };
};

/** The reasoning level to pass to the model call; undefined leaves it to the provider. */
export const getReasoningForCall = (reasoning: EffectiveReasoning): Reasoning | undefined => (reasoning.source === 'default' ? undefined : reasoning.value);

const clearsTemperature = (providerParameters: Record<string, unknown>): boolean =>
  Object.prototype.hasOwnProperty.call(providerParameters, 'temperature') && providerParameters.temperature === undefined;

/**
 * Temperature, in order: a model the Model Library marks as not accepting a custom temperature gets none; then the
 * task override ('model-default' sends none); then the agent profile; then the Model Library; otherwise none.
 * Finally, a provider that clears temperature at the resolved reasoning level (thinking on) gets none.
 */
export const resolveEffectiveTemperature = (
  profile: AgentProfile,
  overrides: TaskModelOverrides | null | undefined,
  applyOverrides: boolean,
  model: Model | undefined,
  providerParameters: Record<string, unknown>,
): EffectiveTemperature => {
  if (model?.acceptsTemperature === false) {
    return {
      value: undefined,
      source: 'default',
      locked: true,
      clearedByReasoning: false,
    };
  }

  const override = applyOverrides ? overrides?.temperatureOverride : undefined;
  let resolved: Pick<EffectiveTemperature, 'value' | 'source'>;
  if (typeof override === 'number') {
    resolved = { value: override, source: 'task' };
  } else if (override === 'model-default') {
    resolved = { value: undefined, source: 'task' };
  } else if (typeof profile.temperature === 'number') {
    resolved = { value: profile.temperature, source: 'agent-profile' };
  } else if (typeof model?.temperature === 'number') {
    resolved = { value: model.temperature, source: 'model-library' };
  } else {
    resolved = { value: undefined, source: 'default' };
  }

  const clearedByReasoning = clearsTemperature(providerParameters);
  return {
    value: clearedByReasoning ? undefined : resolved.value,
    source: resolved.source,
    locked: false,
    clearedByReasoning,
  };
};

/** The single source of the reasoning and temperature an agent run sends; used by the agent run and by the UI. */
export const resolveEffectiveModelSettings = ({
  profile,
  taskAgentProfileId,
  overrides,
  model,
  getProviderParameters,
}: EffectiveModelSettingsInput): EffectiveModelSettings => {
  const applyOverrides = isTaskMainAgent(profile, taskAgentProfileId);
  const reasoning = resolveEffectiveReasoning(profile, overrides, applyOverrides);
  const temperature = resolveEffectiveTemperature(profile, overrides, applyOverrides, model, getProviderParameters(getReasoningForCall(reasoning)));

  return {
    agentProfileId: profile.id,
    agentProfileName: profile.name,
    reasoning,
    temperature,
  };
};
