import { useState } from 'react';
import { AgentProfile, DEFAULT_WORKFLOW_MODEL_SET_ID, Model, ProviderProfile, SettingsData, WorkflowInfo, WorkflowModelSet } from '@common/types';
import { buildDefaultWorkflowModelSet, getProviderModelId, getWorkflowModelSetLabel } from '@common/agent';
import { extractProviderModel } from '@common/utils';
import { v4 as uuidv4 } from 'uuid';
import { FaCheck, FaPencilAlt, FaPlus, FaTrash } from 'react-icons/fa';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

import { ModelSelectorWrapper } from '../common/ModelSelectorWrapper';

type Props = {
  workflow: WorkflowInfo;
  settings: SettingsData;
  setSettings: (updated: SettingsData) => void;
  providers?: ProviderProfile[];
  agentProfiles?: AgentProfile[];
};

export const WorkflowModelSets = ({ workflow, settings, setSettings, providers = [], agentProfiles = [] }: Props) => {
  const { t } = useTranslation();
  const [editingSetId, setEditingSetId] = useState<string | null>(null);

  const writeSets = (next: WorkflowModelSet[]) => {
    setSettings({
      ...settings,
      workflowModelSets: { ...(settings.workflowModelSets ?? {}), [workflow.id]: next },
    });
  };

  const getSets = (): WorkflowModelSet[] => settings.workflowModelSets?.[workflow.id] ?? [];

  const getEffectiveSets = (): WorkflowModelSet[] => {
    const persisted = getSets();
    if (persisted.some((s) => s.id === DEFAULT_WORKFLOW_MODEL_SET_ID)) {
      return persisted;
    }
    return [buildDefaultWorkflowModelSet(workflow.agents, agentProfiles.filter((p) => p.workflowAgent)), ...persisted];
  };

  const upsertSet = (updated: WorkflowModelSet) => {
    const current = getSets();
    const idx = current.findIndex((s) => s.id === updated.id);
    const next = idx === -1 ? [...current, updated] : current.map((s) => (s.id === updated.id ? updated : s));
    writeSets(next);
  };

  const addSet = () => {
    const newSet: WorkflowModelSet = { id: uuidv4(), name: t('workflowsSettings.newSetName'), models: {} };
    writeSets([...getSets(), newSet]);
    setEditingSetId(newSet.id);
  };

  const deleteSet = (setId: string) => {
    if (getEffectiveSets().length <= 1) return;
    writeSets(getSets().filter((s) => s.id !== setId));
    if (editingSetId === setId) setEditingSetId(null);
  };

  const renameSet = (setId: string, name: string) => {
    if (setId === DEFAULT_WORKFLOW_MODEL_SET_ID) return;
    const target = getEffectiveSets().find((s) => s.id === setId);
    if (!target) return;
    upsertSet({ ...target, name });
  };

  const setRoleModel = (setId: string, roleName: string, model: Model | null) => {
    const target = getEffectiveSets().find((s) => s.id === setId);
    if (!target) return;
    const models = { ...target.models };
    if (model === null) delete models[roleName];
    else models[roleName] = getProviderModelId(model);
    upsertSet({ ...target, models });
  };

  const sets = getEffectiveSets();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <button
          className="flex items-center gap-1 px-2 py-1 text-2xs rounded border border-border-default text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
          onClick={addSet}
        >
          <FaPlus className="w-2.5 h-2.5" />
          <span>{t('workflowsSettings.addModelSet')}</span>
        </button>
      </div>

      {sets.map((set) => {
        const isEditing = editingSetId === set.id;
        const isDefault = set.id === DEFAULT_WORKFLOW_MODEL_SET_ID;
        const canDelete = sets.length > 1;
        const label = getWorkflowModelSetLabel(set);

        return (
          <div key={set.id} className="border border-border-default rounded-md bg-bg-secondary overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <span className="flex-1 min-w-0 truncate text-xs text-text-primary" title={label}>
                {set.name}
                {label !== set.name && <span className="text-text-muted">{label.slice(set.name.length)}</span>}
              </span>
              {isDefault && <span className="text-3xs text-text-muted px-1 py-0.5 rounded bg-bg-tertiary flex-shrink-0">{t('workflowsSettings.builtIn')}</span>}
              <button
                className="flex items-center gap-1 px-1.5 py-0.5 text-2xs rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                onClick={() => setEditingSetId(isEditing ? null : set.id)}
              >
                <FaPencilAlt className="w-2.5 h-2.5" />
                <span>{t('common.edit')}</span>
              </button>
              <button
                className={clsx(
                  'flex items-center gap-1 px-1.5 py-0.5 text-2xs rounded transition-colors',
                  canDelete ? 'text-text-muted hover:text-text-danger hover:bg-bg-tertiary' : 'text-text-muted opacity-40 cursor-not-allowed',
                )}
                onClick={() => deleteSet(set.id)}
                disabled={!canDelete}
                title={canDelete ? undefined : t('workflowsSettings.atLeastOneSet')}
              >
                <FaTrash className="w-2.5 h-2.5" />
                <span>{t('common.delete')}</span>
              </button>
            </div>

            {isEditing && (
              <div className="px-3 pb-2.5 space-y-2 border-t border-border-default">
                <div className="pt-2">
                  <label className="text-2xs text-text-muted block mb-1">{t('workflowsSettings.modelSetName')}</label>
                  <input
                    className={clsx(
                      'w-full px-2 py-1 text-xs bg-bg-secondary-light border border-border-default rounded focus:outline-none focus:border-border-light text-text-primary',
                      isDefault && 'opacity-60 cursor-not-allowed',
                    )}
                    value={set.name}
                    readOnly={isDefault}
                    onChange={(e) => renameSet(set.id, e.target.value)}
                  />
                </div>

                {workflow.agents.map((roleName) => {
                  const value = set.models[roleName];
                  const [providerId] = value ? extractProviderModel(value) : [''];
                  const modelUnavailable = !!value && !providers.some((p) => p.id === providerId);

                  return (
                    <div key={roleName} className="flex items-center gap-2">
                      <span className="w-36 flex-shrink-0 text-xs text-text-secondary truncate" title={roleName}>
                        {roleName}
                      </span>
                      <div className="flex-1 p-2 bg-bg-secondary-light border-2 border-border-default rounded focus-within:outline-none focus-within:border-border-light">
                        <ModelSelectorWrapper
                          className="w-full justify-between"
                          selectedModelId={value ?? null}
                          onChange={(model) => setRoleModel(set.id, roleName, model)}
                          labelOnNull={t('workflowsSettings.agentProfileDefault')}
                          skipPreferredModelsUpdate
                          usePortal
                          popupPlacement="bottom"
                        />
                      </div>
                      {modelUnavailable && (
                        <span
                          className="text-2xs text-text-warning flex-shrink-0"
                          title={t('workflowsSettings.providerNotConfigured', { provider: providerId })}
                        >
                          ⚠ {t('workflowsSettings.modelUnavailable')}
                        </span>
                      )}
                    </div>
                  );
                })}

                <div className="flex justify-end pt-1">
                  <button
                    className="flex items-center gap-1 px-2 py-1 text-2xs rounded border border-border-default text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                    onClick={() => setEditingSetId(null)}
                  >
                    <FaCheck className="w-2.5 h-2.5" />
                    <span>{t('workflowsSettings.done')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default WorkflowModelSets;
