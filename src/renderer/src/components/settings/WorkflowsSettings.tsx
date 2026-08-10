import { useState } from 'react';
import { AgentProfile, AVAILABLE_WORKFLOWS, DEFAULT_WORKFLOW_MODEL_SET_ID, ProjectData, ProviderProfile, SettingsData } from '@common/types';
import { useTranslation } from 'react-i18next';
import { LuWorkflow } from 'react-icons/lu';
import { clsx } from 'clsx';

import { Checkbox } from '@/components/common/Checkbox';
import { getPathBasename } from '@/utils/path-utils';

import { WorkflowModelSets } from './WorkflowModelSets';

type Props = {
  projects: ProjectData[];
  workflowsByProject: Record<string, string[]>;
  onToggleWorkflowForProject: (baseDir: string, workflowId: string, checked: boolean) => void;
  settings: SettingsData;
  setSettings: (updated: SettingsData) => void;
  providers?: ProviderProfile[];
  agentProfiles?: AgentProfile[];
  workflowModelSetIdsByProject: Record<string, Record<string, string>>;
  onSetWorkflowModelSetId: (baseDir: string, workflowId: string, setId: string) => void;
};

export const WorkflowsSettings = ({
  projects,
  workflowsByProject,
  onToggleWorkflowForProject,
  settings,
  setSettings,
  providers,
  agentProfiles,
  workflowModelSetIdsByProject,
  onSetWorkflowModelSetId,
}: Props) => {
  const { t } = useTranslation();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(AVAILABLE_WORKFLOWS[0]?.id ?? null);
  const [activeTab, setActiveTab] = useState<'projects' | 'modelSets'>('projects');

  const selectedWorkflow = AVAILABLE_WORKFLOWS.find((w) => w.id === selectedWorkflowId) ?? null;

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="w-[260px] flex-shrink-0 border-r border-border-default flex flex-col min-h-0">
        <div className="p-3 border-b border-border-default">
          <div className="text-xs text-text-secondary truncate">{t('workflowsSettings.title')}</div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-bg-tertiary">
          {AVAILABLE_WORKFLOWS.length === 0 ? (
            <div className="h-full px-8 text-center flex items-center justify-center py-8 text-text-muted-light text-xs">
              {t('workflowsSettings.noWorkflows')}
            </div>
          ) : (
            AVAILABLE_WORKFLOWS.map((workflow) => {
              const isSelected = selectedWorkflowId === workflow.id;
              return (
                <div
                  key={workflow.id}
                  className={clsx(
                    'flex items-center px-3 py-2 rounded-md cursor-pointer transition-colors duration-150 text-sm',
                    isSelected ? 'bg-bg-active text-text-primary bg-bg-secondary' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
                  )}
                  onClick={() => {
                    setSelectedWorkflowId(workflow.id);
                    setActiveTab('projects');
                  }}
                >
                  <LuWorkflow className="w-3.5 h-3.5 mr-2" />
                  <span className="flex-1 truncate">{workflow.name}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {selectedWorkflow ? (
          <>
            <div className="px-6 pt-5 pb-0 border-b border-border-default flex-shrink-0">
              <div className="text-sm font-medium text-text-primary">{selectedWorkflow.name}</div>
              <div className="flex gap-4 mt-3">
                {(['projects', 'modelSets'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={clsx(
                      'pb-2 text-xs border-b-2 transition-colors',
                      activeTab === tab
                        ? 'border-border-accent text-text-primary'
                        : 'border-transparent text-text-muted hover:text-text-primary',
                    )}
                  >
                    {t(`workflowsSettings.tabs.${tab}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-bg-tertiary">
              {activeTab === 'projects' ? (
                projects.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-xs text-text-muted">{t('workflowsSettings.noProjects')}</div>
                ) : (
                  <div className="space-y-2 max-w-3xl">
                    {projects.map((project) => {
                      const isEnabled = (workflowsByProject[project.baseDir] ?? []).includes(selectedWorkflow.id);
                      return (
                        <div
                          key={project.baseDir}
                          className="flex items-center justify-between p-3 border border-border-default rounded-md bg-bg-secondary-light"
                        >
                          <span className="text-sm text-text-primary truncate">{getPathBasename(project.baseDir)}</span>
                          <div className="flex items-center gap-6">
                            {isEnabled && (
                              <select
                                className="h-7 text-2xs bg-bg-secondary border border-border-default rounded pl-1.5 pr-2 text-text-primary cursor-pointer focus:outline-none focus:border-border-light"
                                value={workflowModelSetIdsByProject[project.baseDir]?.[selectedWorkflow.id] ?? DEFAULT_WORKFLOW_MODEL_SET_ID}
                                onChange={(e) => onSetWorkflowModelSetId(project.baseDir, selectedWorkflow.id, e.target.value)}
                              >
                                <option value={DEFAULT_WORKFLOW_MODEL_SET_ID}>{t('workflowsSettings.defaultSetName')}</option>
                                {(settings.workflowModelSets?.[selectedWorkflow.id] ?? [])
                                  .filter((set) => set.id !== DEFAULT_WORKFLOW_MODEL_SET_ID)
                                  .map((set) => (
                                    <option key={set.id} value={set.id}>
                                      {set.name}
                                    </option>
                                  ))}
                              </select>
                            )}
                            <Checkbox
                              checked={isEnabled}
                              onChange={(checked) => onToggleWorkflowForProject(project.baseDir, selectedWorkflow.id, checked)}
                              size="sm"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <WorkflowModelSets
                  workflow={selectedWorkflow}
                  settings={settings}
                  setSettings={setSettings}
                  providers={providers}
                  agentProfiles={agentProfiles}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-xs">
            <p className="text-text-muted">{t('workflowsSettings.selectWorkflow')}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkflowsSettings;
