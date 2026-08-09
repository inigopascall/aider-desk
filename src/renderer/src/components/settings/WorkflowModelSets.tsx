import { useState } from 'react';
import { AVAILABLE_WORKFLOWS, Model, ProviderProfile, SettingsData, WorkflowModelSet } from '@common/types';
import { getProviderModelId } from '@common/agent';
import { extractProviderModel } from '@common/utils';
import { v4 as uuidv4 } from 'uuid';
import { FaCheck, FaChevronDown, FaChevronRight, FaPencilAlt, FaPlus, FaTrash } from 'react-icons/fa';
import { clsx } from 'clsx';

import { ModelSelectorWrapper } from '../common/ModelSelectorWrapper';

type Props = {
  settings: SettingsData;
  setSettings: (updated: SettingsData) => void;
  providers?: ProviderProfile[];
};

/**
 * Editor for per-workflow model sets. Each set maps an agent role name
 * (from the workflow's `agents` list) to a model id of the form
 * "provider/model". Saving is deferred to the enclosing settings page —
 * this component only stages changes through the supplied setter.
 */
export const WorkflowModelSets = ({ settings, setSettings, providers = [] }: Props) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editingKey, setEditingKey] = useState<{ workflowId: string; setId: string } | null>(null);

  const writeSets = (workflowId: string, next: WorkflowModelSet[]) => {
    setSettings({
      ...settings,
      workflowModelSets: { ...(settings.workflowModelSets ?? {}), [workflowId]: next },
    });
  };

  const getSets = (workflowId: string) => settings.workflowModelSets?.[workflowId] ?? [];

  const addSet = (workflowId: string) => {
    const newSet: WorkflowModelSet = { id: uuidv4(), name: 'New set', models: {} };
    writeSets(workflowId, [...getSets(workflowId), newSet]);
    setEditingKey({ workflowId, setId: newSet.id });
  };

  const deleteSet = (workflowId: string, setId: string) => {
    writeSets(
      workflowId,
      getSets(workflowId).filter((s) => s.id !== setId),
    );
    if (editingKey?.workflowId === workflowId && editingKey.setId === setId) {
      setEditingKey(null);
    }
  };

  const renameSet = (workflowId: string, setId: string, name: string) => {
    writeSets(
      workflowId,
      getSets(workflowId).map((s) => (s.id === setId ? { ...s, name } : s)),
    );
  };

  const setRoleModel = (workflowId: string, setId: string, roleName: string, model: Model | null) => {
    writeSets(
      workflowId,
      getSets(workflowId).map((s) => {
        if (s.id !== setId) return s;
        const models = { ...s.models };
        if (model === null) {
          // "Unset" means the agent profile's own model is used.
          delete models[roleName];
        } else {
          models[roleName] = getProviderModelId(model);
        }
        return { ...s, models };
      }),
    );
  };

  if (AVAILABLE_WORKFLOWS.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {AVAILABLE_WORKFLOWS.map((workflow) => {
        const sets = getSets(workflow.id);
        const isCollapsed = collapsed[workflow.id] ?? false;

        return (
          <div key={workflow.id} className="border border-border-default rounded-md bg-bg-secondary-light overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                className="flex items-center gap-2 flex-1 text-left"
                onClick={() => setCollapsed((prev) => ({ ...prev, [workflow.id]: !prev[workflow.id] }))}
              >
                <span className="text-text-muted">
                  {isCollapsed ? <FaChevronRight className="w-3 h-3" /> : <FaChevronDown className="w-3 h-3" />}
                </span>
                <span className="text-sm font-medium text-text-primary">{workflow.name}</span>
                <span className="text-2xs text-text-muted">({sets.length})</span>
              </button>
              <button
                className="flex items-center gap-1 px-2 py-1 text-2xs rounded border border-border-default text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                onClick={() => addSet(workflow.id)}
              >
                <FaPlus className="w-2.5 h-2.5" />
                <span>Add model set</span>
              </button>
            </div>

            {!isCollapsed && (
              <div className="px-3 pb-3 space-y-2">
                {sets.length === 0 && (
                  <div className="text-2xs text-text-muted px-1">No model sets defined. Add one to override agent models per role.</div>
                )}
                {sets.map((set) => {
                  const isEditing = editingKey?.workflowId === workflow.id && editingKey.setId === set.id;
                  return (
                    <div key={set.id} className="border border-border-default rounded-md bg-bg-secondary overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-1.5">
                        <span className="flex-1 truncate text-xs text-text-primary">{set.name}</span>
                        <button
                          className="flex items-center gap-1 px-1.5 py-0.5 text-2xs rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                          onClick={() => setEditingKey(isEditing ? null : { workflowId: workflow.id, setId: set.id })}
                        >
                          <FaPencilAlt className="w-2.5 h-2.5" />
                          <span>Edit</span>
                        </button>
                        <button
                          className="flex items-center gap-1 px-1.5 py-0.5 text-2xs rounded text-text-muted hover:text-text-danger hover:bg-bg-tertiary transition-colors"
                          onClick={() => deleteSet(workflow.id, set.id)}
                        >
                          <FaTrash className="w-2.5 h-2.5" />
                          <span>Delete</span>
                        </button>
                      </div>

                      {isEditing && (
                        <div className="px-3 pb-2.5 space-y-2 border-t border-border-default">
                          <div className="pt-2">
                            <label className="text-2xs text-text-muted block mb-1">Name</label>
                            <input
                              className="w-full px-2 py-1 text-xs bg-bg-secondary-light border border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
                              value={set.name}
                              onChange={(e) => renameSet(workflow.id, set.id, e.target.value)}
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
                                    onChange={(model) => setRoleModel(workflow.id, set.id, roleName, model)}
                                    labelOnNull="Agent profile default"
                                    skipPreferredModelsUpdate
                                  />
                                </div>
                                {modelUnavailable && (
                                  <span className="text-2xs text-text-warning flex-shrink-0" title={`Provider '${providerId}' is not configured.`}>
                                    ⚠ Model unavailable
                                  </span>
                                )}
                              </div>
                            );
                          })}

                          <div className="flex justify-end pt-1">
                            <button
                              className={clsx(
                                'flex items-center gap-1 px-2 py-1 text-2xs rounded border border-border-default text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors',
                              )}
                              onClick={() => setEditingKey(null)}
                            >
                              <FaCheck className="w-2.5 h-2.5" />
                              <span>Done</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default WorkflowModelSets;