import { EffectiveModelSettings, TaskData } from '@common/types';
import { useEffect, useState } from 'react';

import { useApi } from '@/contexts/ApiContext';
import { useAgents } from '@/contexts/AgentsContext';
import { useModelProviders } from '@/contexts/ModelProviderContext';
import { useProjectSettings } from '@/contexts/ProjectSettingsContext';

/**
 * The reasoning and temperature the task's main agent will send, resolved in the main process.
 * Re-fetched whenever anything that feeds the resolution changes.
 */
export const useEffectiveModelSettings = (task: TaskData): EffectiveModelSettings | null => {
  const api = useApi();
  const { profiles } = useAgents();
  const { models, providers } = useModelProviders();
  const { projectSettings } = useProjectSettings();
  const [settings, setSettings] = useState<EffectiveModelSettings | null>(null);

  const { baseDir, id, provider, model, agentProfileId, reasoningOverride, temperatureOverride, currentMode } = task;

  useEffect(() => {
    let cancelled = false;
    api
      .getEffectiveModelSettings(baseDir, id)
      .then((result) => {
        if (!cancelled) {
          setSettings(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, baseDir, id, provider, model, agentProfileId, reasoningOverride, temperatureOverride, currentMode, profiles, models, providers, projectSettings]);

  return settings;
};
