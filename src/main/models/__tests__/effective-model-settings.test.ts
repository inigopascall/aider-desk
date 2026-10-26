vi.mock('@/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { describe, expect, it, vi } from 'vitest';

import { resolveEffectiveModelSettings } from '../effective-model-settings';
import { deepseekProviderStrategy } from '../providers/deepseek';

import type { DeepseekProvider } from '@common/agent';
import type { AgentProfile, Model, Reasoning } from '@common/types';
import type { EffectiveModelSettingsInput } from '../effective-model-settings';

import { createMockAgentProfile } from '@/__tests__/mocks';

const TASK_PROFILE_ID = 'main-profile';

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  createMockAgentProfile({
    id: TASK_PROFILE_ID,
    name: 'WORKHORSE',
    temperature: undefined,
    reasoning: undefined,
    ...overrides,
  });

const model = (overrides: Partial<Model> = {}): Model => ({
  id: 'model',
  providerId: 'provider',
  ...overrides,
});

const resolve = (input: Partial<EffectiveModelSettingsInput> & Pick<EffectiveModelSettingsInput, 'profile'>) =>
  resolveEffectiveModelSettings({
    taskAgentProfileId: TASK_PROFILE_ID,
    getProviderParameters: () => ({}),
    ...input,
  });

describe('resolveEffectiveModelSettings - temperature', () => {
  it('sends a task number override', () => {
    const result = resolve({
      profile: profile({ temperature: 0.4 }),
      model: model({ temperature: 0.7 }),
      overrides: { temperatureOverride: 0.2 },
    });

    expect(result.temperature).toEqual({
      value: 0.2,
      source: 'task',
      locked: false,
      clearedByReasoning: false,
    });
  });

  it("sends none for the task's 'model-default', with source task", () => {
    const result = resolve({
      profile: profile({ temperature: 0.4 }),
      model: model({ temperature: 0.7 }),
      overrides: { temperatureOverride: 'model-default' },
    });

    expect(result.temperature).toEqual({
      value: undefined,
      source: 'task',
      locked: false,
      clearedByReasoning: false,
    });
  });

  it('falls through to the agent profile when the task override is null', () => {
    const result = resolve({
      profile: profile({ temperature: 0.4 }),
      model: model({ temperature: 0.7 }),
      overrides: { temperatureOverride: null },
    });

    expect(result.temperature).toEqual({
      value: 0.4,
      source: 'agent-profile',
      locked: false,
      clearedByReasoning: false,
    });
  });

  it('falls through to the Model Library when the profile sets none', () => {
    const result = resolve({
      profile: profile(),
      model: model({ temperature: 0.7 }),
      overrides: {},
    });

    expect(result.temperature).toEqual({
      value: 0.7,
      source: 'model-library',
      locked: false,
      clearedByReasoning: false,
    });
  });

  it('sends none, with source default, when nothing sets a temperature', () => {
    const result = resolve({ profile: profile(), model: model() });

    expect(result.temperature).toEqual({
      value: undefined,
      source: 'default',
      locked: false,
      clearedByReasoning: false,
    });
  });

  it('a locked model beats the task, profile and library values', () => {
    const result = resolve({
      profile: profile({ temperature: 0.4 }),
      model: model({ temperature: 0.7, acceptsTemperature: false }),
      overrides: { temperatureOverride: 0.2 },
    });

    expect(result.temperature).toEqual({
      value: undefined,
      source: 'default',
      locked: true,
      clearedByReasoning: false,
    });
  });

  it('a sub-agent ignores the task overrides but is still locked', () => {
    const overrides = {
      temperatureOverride: 0.2,
      reasoningOverride: 'high' as const,
    };
    const subagent = profile({ isSubagent: true, temperature: 0.4 });

    const unlocked = resolve({ profile: subagent, model: model(), overrides });
    expect(unlocked.temperature).toEqual({
      value: 0.4,
      source: 'agent-profile',
      locked: false,
      clearedByReasoning: false,
    });
    expect(unlocked.reasoning).toEqual({
      value: 'provider-default',
      source: 'default',
    });

    const locked = resolve({
      profile: subagent,
      model: model({ acceptsTemperature: false }),
      overrides,
    });
    expect(locked.temperature.locked).toBe(true);
    expect(locked.temperature.value).toBeUndefined();
  });

  it("a profile other than the task's own ignores the task overrides", () => {
    const result = resolve({
      profile: profile({ id: 'internal-profile', temperature: 0.4 }),
      overrides: { temperatureOverride: 0.2 },
    });

    expect(result.temperature.value).toBe(0.4);
    expect(result.temperature.source).toBe('agent-profile');
  });

  it('returns the agent profile id and name', () => {
    const result = resolve({ profile: profile() });

    expect(result.agentProfileId).toBe(TASK_PROFILE_ID);
    expect(result.agentProfileName).toBe('WORKHORSE');
  });
});

describe('resolveEffectiveModelSettings - reasoning', () => {
  it('uses the task override first', () => {
    const result = resolve({
      profile: profile({ reasoning: 'low' }),
      overrides: { reasoningOverride: 'high' },
    });

    expect(result.reasoning).toEqual({ value: 'high', source: 'task' });
  });

  it('then the agent profile', () => {
    const result = resolve({
      profile: profile({ reasoning: 'low' }),
      overrides: { reasoningOverride: null },
    });

    expect(result.reasoning).toEqual({ value: 'low', source: 'agent-profile' });
  });

  it('then the provider default', () => {
    const result = resolve({ profile: profile() });

    expect(result.reasoning).toEqual({
      value: 'provider-default',
      source: 'default',
    });
  });

  it('passes the resolved reasoning to the provider parameters, and nothing for the provider default', () => {
    const getProviderParameters = vi.fn(() => ({}));

    resolve({
      profile: profile(),
      overrides: { reasoningOverride: 'medium' },
      getProviderParameters,
    });
    resolve({ profile: profile(), getProviderParameters });

    expect(getProviderParameters).toHaveBeenNthCalledWith(1, 'medium');
    expect(getProviderParameters).toHaveBeenNthCalledWith(2, undefined);
  });
});

describe('resolveEffectiveModelSettings - clearedByReasoning', () => {
  const deepseekModel = model({ id: 'deepseek-chat', providerId: 'deepseek' });
  const deepseekParameters = (reasoning?: Reasoning) =>
    deepseekProviderStrategy.getProviderParameters!({ name: 'deepseek', apiKey: 'key' } as DeepseekProvider, deepseekModel, reasoning);

  it('sends no temperature while DeepSeek thinking is on', () => {
    const result = resolve({
      profile: profile({ temperature: 0.4 }),
      model: deepseekModel,
      overrides: { reasoningOverride: 'high' },
      getProviderParameters: deepseekParameters,
    });

    expect(result.temperature).toEqual({
      value: undefined,
      source: 'agent-profile',
      locked: false,
      clearedByReasoning: true,
    });
  });

  it('sends the temperature when DeepSeek thinking is off', () => {
    const result = resolve({
      profile: profile({ temperature: 0.4 }),
      model: deepseekModel,
      overrides: { reasoningOverride: 'none' },
      getProviderParameters: deepseekParameters,
    });

    expect(result.temperature).toEqual({
      value: 0.4,
      source: 'agent-profile',
      locked: false,
      clearedByReasoning: false,
    });
  });
});
