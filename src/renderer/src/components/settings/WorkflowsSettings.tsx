import { useState } from 'react';
import { AVAILABLE_WORKFLOWS, ProjectData, ProviderProfile, SettingsData } from '@common/types';
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
  workflowModelSetIdsByProject,
  onSetWorkflowModelSetId,
}: Props) => {
  const { t } = useTranslation();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  const selectedWorkflow = AVAILABLE_WORKFLOWS.find((w) => w.id === selectedWorkflowId) ?? null;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left: workflow list */}
      <div className="w-[260px] flex-shrink-0 border-r border-border-default flex flex-col">
        <div className="p-3 border-b border-border-default">
          <div className="text-xs text-text-secondary truncate">{t('workflowsSettings.title')}</div>
        </div>
        <div className="flex-1 overflow-y-auto p-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-bg-tertiary">
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
                  onClick={() => setSelectedWorkflowId(workflow.id)}
                >
                  <LuWorkflow className="w-3.5 h-3.5 mr-2" />
                  <span className="flex-1 truncate">{workflow.name}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right: project availability for the selected workflow */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedWorkflow ? (
          <>
            <div className="px-6 pt-5 pb-3 border-b border-border-default">
              <div className="text-sm font-medium text-text-primary">{selectedWorkflow.name}</div>
              <div className="text-xs text-text-muted mt-1">{t('workflowsSettings.projectsTitle')}</div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-bg-tertiary">
              {projects.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-text-muted">
                  {t('workflowsSettings.noProjects')}
                </div>
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
                        {isEnabled && (
                          <select
                            className="h-7 text-2xs bg-bg-secondary border border-border-default rounded px-1 text-text-primary focus:outline-none focus:border-border-light"
                            value={workflowModelSetIdsByProject[project.baseDir]?.[selectedWorkflow.id] ?? ''}
                            onChange={(e) => onSetWorkflowModelSetId(project.baseDir, selectedWorkflow.id, e.target.value)}
                          >
                            <option value="">Default</option>
                            {(settings.workflowModelSets?.[selectedWorkflow.id] ?? []).map((set) => (
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
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-xs">
            <p className="text-text-muted">{t('workflowsSettings.selectWorkflow')}</p>
          </div>
        )}
        <div className="p-4 border-t border-border-default space-y-2">
          <div className="text-sm font-medium text-text-primary">Model Sets</div>
          <WorkflowModelSets settings={settings} setSettings={setSettings} providers={providers} />
        </div>
      </div>
    </div>
  );
};

export default WorkflowsSettings;
