import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_WORKFLOW_COLOR,
  Model,
  WorkflowAgentModels,
  WorkflowConfig,
  WorkflowInfo,
  WORKFLOW_ARBITER_ROLE,
  WORKFLOW_OPTIONAL_AGENT_ROLES,
  WORKFLOW_PERSIST_PRIMARY_DEFAULT_ROLES,
  WORKFLOW_REVIEWER_ROLES,
} from '@common/types';
import { extractProviderModel } from '@common/utils';
import { getProviderModelId } from '@common/agent';

import { BaseDialog } from '@/components/common/BaseDialog';
import { Button } from '@/components/common/Button';
import { Checkbox } from '@/components/common/Checkbox';
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
 * per agent role, persist-primary toggles, the parallel editor count, and
 * optional pre-arbiter / post-workflow shell commands.
 */
export const WorkflowConfigModal = ({ workflow, onCancel, onSaveAndClose, onSaveAndGo }: Props) => {
  const { t } = useTranslation();
  const { projectSettings, saveProjectSettings } = useProjectSettings();
  const { getWorkflowAgentProfiles } = useAgents();
  const { providers } = useModelProviders();

  const persisted = projectSettings?.workflowConfigs?.[workflow.id];
  const [agentModels, setAgentModels] = useState<Record<string, WorkflowAgentModels>>(() => ({ ...(persisted?.agentModels ?? {}) }));
  const [enabledAgents, setEnabledAgents] = useState<Record<string, boolean>>(() => ({ ...(persisted?.enabledAgents ?? {}) }));
  const [persistPrimary, setPersistPrimary] = useState<Record<string, boolean>>(() => ({ ...(persisted?.persistPrimary ?? {}) }));
  const [parallelEditorsText, setParallelEditorsText] = useState(() => String(persisted?.parallelEditors ?? 0));
  const [preArbiterCommand, setPreArbiterCommand] = useState(persisted?.preArbiterCommand ?? '');
  const [bashCommand, setBashCommand] = useState(persisted?.bashCommand ?? '');

  const workflowProfiles = getWorkflowAgentProfiles();

  const optionalRoles = WORKFLOW_OPTIONAL_AGENT_ROLES[workflow.id] ?? [];
  const arbiterEnabled = enabledAgents[WORKFLOW_ARBITER_ROLE] === true;

  const toggleAgent = (role: string) => {
    setEnabledAgents((prev) => {
      const isReviewer = WORKFLOW_REVIEWER_ROLES.includes(role);
      const arbiterOn = prev[WORKFLOW_ARBITER_ROLE] === true;
      if (isReviewer && !arbiterOn) return prev;
      const next = { ...prev, [role]: !prev[role] };
      if (role === WORKFLOW_ARBITER_ROLE && !next[role]) {
        for (const reviewer of WORKFLOW_REVIEWER_ROLES) {
          next[reviewer] = false;
        }
      }
      return next;
    });
  };

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

  const isPersistPrimaryChecked = (role: string): boolean => {
    const stored = persistPrimary[role];
    if (stored !== undefined) return stored;
    return WORKFLOW_PERSIST_PRIMARY_DEFAULT_ROLES.includes(role);
  };

  const togglePersistPrimary = (role: string) => {
    setPersistPrimary((prev) => {
      const current = prev[role] !== undefined ? prev[role] : WORKFLOW_PERSIST_PRIMARY_DEFAULT_ROLES.includes(role);
      return { ...prev, [role]: !current };
    });
  };

  const parseParallelEditors = (text: string): number => {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return 0;
    const value = Number(trimmed);
    return value > 0 ? value : 0;
  };

  const persist = async () => {
    if (!projectSettings) return;
    const pruned: Record<string, WorkflowAgentModels> = {};
    for (const [role, m] of Object.entries(agentModels)) {
      if (workflow.agents.includes(role) && (m.primary || m.fallback)) pruned[role] = m;
    }
    const optionalRoles = WORKFLOW_OPTIONAL_AGENT_ROLES[workflow.id] ?? [];
    const arbiterOn = enabledAgents[WORKFLOW_ARBITER_ROLE] === true;
    const enabledAgentsRecord: Record<string, boolean> = {};
    for (const role of optionalRoles) {
      const isReviewer = WORKFLOW_REVIEWER_ROLES.includes(role);
      enabledAgentsRecord[role] = isReviewer ? arbiterOn && enabledAgents[role] === true : enabledAgents[role] === true;
    }
    const persistPrimaryRecord: Record<string, boolean> = {};
    for (const role of workflow.agents) {
      persistPrimaryRecord[role] = isPersistPrimaryChecked(role);
    }
    const config: WorkflowConfig = {
      agentModels: pruned,
      preArbiterCommand: preArbiterCommand.trim() || undefined,
      bashCommand: bashCommand.trim() || undefined,
      enabledAgents: enabledAgentsRecord,
      persistPrimary: persistPrimaryRecord,
      parallelEditors: parseParallelEditors(parallelEditorsText),
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
      width="fit-content"
      minWidth={1140}
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
        <div
          className="grid gap-2 items-center"
          style={{ gridTemplateColumns: '12px 160px minmax(320px, 1fr) minmax(320px, 1fr) auto 40px' }}
        >
          <Fragment>
            <div className="w-3 h-3 flex-shrink-0" />
            <div />
            <div className="text-2xs text-text-muted">{t('workflowsSettings.primaryModel')}</div>
            <div className="text-2xs text-text-muted">{t('workflowsSettings.fallbackModel')}</div>
            <div className="text-2xs text-text-muted text-center">{t('workflowsSettings.persistPrimaryColumn')}</div>
            <div className="text-2xs text-text-muted text-center">{t('workflowsSettings.runColumn')}</div>
          </Fragment>
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
              <Fragment key={role}>
                <span
                  className="w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: defaultProfile?.subagent.color ?? DEFAULT_WORKFLOW_COLOR }}
                />
                <span className="w-40 flex-shrink-0 text-xs font-medium uppercase truncate text-text-secondary" title={role}>
                  {role}
                </span>
                <div className="min-w-0 p-2 bg-bg-secondary-light border-2 border-border-default rounded focus-within:border-border-light">
                  <ModelSelectorWrapper
                    className="w-full justify-between"
                    selectedModelId={agentModels[role]?.primary ?? null}
                    onChange={(model) => setRoleModel(role, 'primary', model)}
                    labelOnNull={defaultLabel}
                    labelOnNullProviderId={defaultProfile?.provider}
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
                <div className="min-w-0 p-2 bg-bg-secondary-light border-2 border-border-default rounded focus-within:border-border-light">
                  <ModelSelectorWrapper
                    className="w-full justify-between"
                    selectedModelId={agentModels[role]?.fallback ?? null}
                    onChange={(model) => setRoleModel(role, 'fallback', model)}
                    labelOnNull={defaultLabel}
                    labelOnNullProviderId={defaultProfile?.provider}
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
                <div className="flex justify-center">
                  <Checkbox
                    checked={isPersistPrimaryChecked(role)}
                    onChange={() => togglePersistPrimary(role)}
                    tooltip={t('workflowsSettings.persistPrimaryTooltip')}
                  />
                </div>
                {optionalRoles.includes(role) ? (
                  <div className="w-10 flex-shrink-0 flex justify-center">
                    <Checkbox
                      checked={enabledAgents[role] === true}
                      onChange={() => toggleAgent(role)}
                      tooltip={
                        WORKFLOW_REVIEWER_ROLES.includes(role)
                          ? t('workflowsSettings.reviewerRequiresArbiter')
                          : t('workflowsSettings.agentEnabledTooltip')
                      }
                      className={WORKFLOW_REVIEWER_ROLES.includes(role) && !arbiterEnabled ? 'pointer-events-none opacity-50' : ''}
                    />
                  </div>
                ) : (
                  <div className="w-10 flex-shrink-0" />
                )}
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border-default pt-3 mt-3">
        <label className="text-xs font-medium text-text-primary block mb-1">{t('workflowsSettings.parallelEditorsTitle')}</label>
        <p className="text-2xs text-text-muted mb-2">{t('workflowsSettings.parallelEditorsInfo')}</p>
        <input
          type="text"
          inputMode="numeric"
          value={parallelEditorsText}
          onChange={(e) => setParallelEditorsText(e.target.value)}
          placeholder="0"
          className="w-full px-2 py-1 text-xs font-mono bg-bg-secondary-light border border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
        />
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
