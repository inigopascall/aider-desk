import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_WORKFLOW_COLOR, Model, WorkflowAgentModels, WorkflowConfig, WorkflowInfo } from '@common/types';
import { extractProviderModel } from '@common/utils';
import { getProviderModelId } from '@common/agent';

import { BaseDialog } from '@/components/common/BaseDialog';
import { Button } from '@/components/common/Button';
import { ModelSelectorWrapper } from '@/components/common/ModelSelectorWrapper';
import { useAgents } from '@/contexts/AgentsContext';
import { useModelProviders } from '@/contexts/ModelProviderContext';
import { useProjectSettings } from '@/contexts/ProjectSettingsContext';

type Props = {
  workflow: WorkflowInfo;
  onCancel: () => void;
  onSaveAndClose: () => void;
  onSaveAndGo: () => void;
};

/**
 * Modal dialog for configuring per-workflow settings: primary/fallback models
 * per agent role and an optional post-workflow bash command.
 */
export const WorkflowConfigModal = ({ workflow, onCancel, onSaveAndClose, onSaveAndGo }: Props) => {
  const { t } = useTranslation();
  const { projectSettings, saveProjectSettings } = useProjectSettings();
  const { getWorkflowAgentProfiles } = useAgents();
  const { providers } = useModelProviders();

  const persisted = projectSettings?.workflowConfigs?.[workflow.id];
  const [agentModels, setAgentModels] = useState<Record<string, WorkflowAgentModels>>(() => ({ ...(persisted?.agentModels ?? {}) }));
  const [preArbiterCommand, setPreArbiterCommand] = useState(persisted?.preArbiterCommand ?? '');
  const [bashCommand, setBashCommand] = useState(persisted?.bashCommand ?? '');

  const workflowProfiles = getWorkflowAgentProfiles();

  const setRoleModel = (role: string, slot: 'primary' | 'fallback', model: Model | null) => {
    setAgentModels((prev) => {
      const current = prev[role] ?? {};
      const updatedSlot = model ? getProviderModelId(model) : undefined;
      const nextRoleModels: WorkflowAgentModels = { ...current, [slot]: updatedSlot };
      if (!nextRoleModels.primary && !nextRoleModels.fallback) {
        const next = { ...prev };
        delete next[role];
        return next;
      }
      return { ...prev, [role]: nextRoleModels };
    });
  };

  const persist = async () => {
    if (!projectSettings) return;
    const pruned: Record<string, WorkflowAgentModels> = {};
    for (const [role, m] of Object.entries(agentModels)) {
      if (workflow.agents.includes(role) && (m.primary || m.fallback)) pruned[role] = m;
    }
    const config: WorkflowConfig = {
      agentModels: pruned,
      preArbiterCommand: preArbiterCommand.trim() || undefined,
      bashCommand: bashCommand.trim() || undefined,
    };
    await saveProjectSettings({
      workflowConfigs: { ...(projectSettings.workflowConfigs ?? {}), [workflow.id]: config },
    });
  };

  const handleSaveAndClose = async () => {
    await persist();
    onSaveAndClose();
  };

  const handleSaveAndGo = async () => {
    await persist();
    onSaveAndGo();
  };

  return (
    <BaseDialog
      title={t('workflowsSettings.configModalTitle', { name: workflow.name })}
      onClose={onCancel}
      closeOnEscape
      closeOnBackdrop
      enableFocusTrap={false}
      width={760}
      footer={
        <>
          <Button variant="text" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="text" onClick={handleSaveAndClose} disabled={!projectSettings}>
            {t('workflowsSettings.saveAndClose')}
          </Button>
          <Button onClick={handleSaveAndGo} disabled={!projectSettings}>
            {t('workflowsSettings.saveAndGo')}
          </Button>
        </>
      }
    >
      <div>
        <div className="text-xs font-medium text-text-primary mb-2">{t('workflowsSettings.agentModelsTitle')}</div>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-3 h-3 flex-shrink-0" />
          <div className="w-40 flex-shrink-0" />
          <div className="flex-1 text-2xs text-text-muted">{t('workflowsSettings.primaryModel')}</div>
          <div className="flex-1 text-2xs text-text-muted">{t('workflowsSettings.fallbackModel')}</div>
        </div>
        <div className="space-y-2">
          {workflow.agents.map((role) => {
            const defaultProfile = workflowProfiles.find((p) => p.name === role);
            const defaultLabel = defaultProfile?.model
              ? t('workflowsSettings.defaultModelOption', { model: defaultProfile.model })
              : t('workflowsSettings.agentProfileDefault');

            const primaryValue = agentModels[role]?.primary;
            const [primaryProviderId] = primaryValue ? extractProviderModel(primaryValue) : [''];
            const primaryUnavailable = !!primaryValue && !providers.some((p) => p.id === primaryProviderId);

            const fallbackValue = agentModels[role]?.fallback;
            const [fallbackProviderId] = fallbackValue ? extractProviderModel(fallbackValue) : [''];
            const fallbackUnavailable = !!fallbackValue && !providers.some((p) => p.id === fallbackProviderId);

            return (
              <div key={role} className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: defaultProfile?.subagent.color ?? DEFAULT_WORKFLOW_COLOR }}
                />
                <span className="w-40 flex-shrink-0 text-xs font-medium uppercase truncate text-text-secondary" title={role}>
                  {role}
                </span>
                <div className="flex-1 min-w-0 p-2 bg-bg-secondary-light border-2 border-border-default rounded focus-within:border-border-light">
                  <ModelSelectorWrapper
                    className="w-full justify-between"
                    selectedModelId={agentModels[role]?.primary ?? null}
                    onChange={(model) => setRoleModel(role, 'primary', model)}
                    labelOnNull={defaultLabel}
                    skipPreferredModelsUpdate
                    usePortal
                    popupPlacement="bottom"
                  />
                  {primaryUnavailable && (
                    <span
                      className="text-2xs text-text-warning block mt-1"
                      title={t('workflowsSettings.providerNotConfigured', { provider: primaryProviderId })}
                    >
                      ⚠ {t('workflowsSettings.modelUnavailable')}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0 p-2 bg-bg-secondary-light border-2 border-border-default rounded focus-within:border-border-light">
                  <ModelSelectorWrapper
                    className="w-full justify-between"
                    selectedModelId={agentModels[role]?.fallback ?? null}
                    onChange={(model) => setRoleModel(role, 'fallback', model)}
                    labelOnNull={defaultLabel}
                    skipPreferredModelsUpdate
                    usePortal
                    popupPlacement="bottom"
                  />
                  {fallbackUnavailable && (
                    <span
                      className="text-2xs text-text-warning block mt-1"
                      title={t('workflowsSettings.providerNotConfigured', { provider: fallbackProviderId })}
                    >
                      ⚠ {t('workflowsSettings.modelUnavailable')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border-default pt-3 mt-3">
        <label className="text-xs font-medium text-text-primary block mb-1">{t('workflowsSettings.preArbiterCommandTitle')}</label>
        <p className="text-2xs text-text-muted mb-2">{t('workflowsSettings.preArbiterCommandInfo')}</p>
        <textarea
          rows={2}
          value={preArbiterCommand}
          onChange={(e) => setPreArbiterCommand(e.target.value)}
          placeholder={t('workflowsSettings.preArbiterCommandPlaceholder')}
          className="w-full px-2 py-1 text-xs font-mono bg-bg-secondary-light border border-border-default rounded focus:outline-none focus:border-border-light text-text-primary resize-y"
        />
      </div>

      <div className="border-t border-border-default pt-3 mt-3">
        <label className="text-xs font-medium text-text-primary block mb-1">{t('workflowsSettings.bashCommandTitle')}</label>
        <p className="text-2xs text-text-muted mb-2">{t('workflowsSettings.bashCommandInfo')}</p>
        <textarea
          rows={3}
          value={bashCommand}
          onChange={(e) => setBashCommand(e.target.value)}
          placeholder={t('workflowsSettings.bashCommandPlaceholder')}
          className="w-full px-2 py-1 text-xs font-mono bg-bg-secondary-light border border-border-default rounded focus:outline-none focus:border-border-light text-text-primary resize-y"
        />
      </div>
    </BaseDialog>
  );
};

export default WorkflowConfigModal;
