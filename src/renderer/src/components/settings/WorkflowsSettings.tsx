import { useCallback, useEffect, useState } from 'react';
import { AVAILABLE_WORKFLOWS, ProjectData } from '@common/types';
import { useTranslation } from 'react-i18next';
import { LuWorkflow } from 'react-icons/lu';
import { clsx } from 'clsx';

import { Checkbox } from '@/components/common/Checkbox';
import { useApi } from '@/contexts/ApiContext';
import { getPathBasename } from '@/utils/path-utils';

/**
 * WORKFLOWS settings tab: master-detail view that lets the user choose,
 * for each workflow, which open projects it is available in.
 *
 * Availability is stored per-project in `ProjectSettings.enabledWorkflows`.
 * This component talks to the backend directly (getOpenProjects /
 * patchProjectSettings) because it must represent the full set of open
 * projects, not a single project's settings.
 */
export const WorkflowsSettings = () => {
  const { t } = useTranslation();
  const api = useApi();

  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const openProjects = await api.getOpenProjects();
        if (!cancelled) {
          setProjects(openProjects);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to load open projects:', error);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const handleToggleProject = useCallback(
    async (project: ProjectData, workflowId: string, checked: boolean) => {
      const current = project.settings.enabledWorkflows ?? [];
      const next = checked ? [...new Set([...current, workflowId])] : current.filter((id) => id !== workflowId);
      try {
        const updated = await api.patchProjectSettings(project.baseDir, { enabledWorkflows: next });
        // Update local state with the returned settings so the checkbox reflects the saved value
        setProjects((prev) => prev.map((p) => (p.baseDir === project.baseDir ? { ...p, settings: updated } : p)));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Failed to update workflow availability for ${project.baseDir}:`, error);
      }
    },
    [api],
  );

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
                    const isEnabled = (project.settings.enabledWorkflows ?? []).includes(selectedWorkflow.id);
                    return (
                      <div
                        key={project.baseDir}
                        className="flex items-center justify-between p-3 border border-border-default rounded-md bg-bg-secondary-light"
                      >
                        <span className="text-sm text-text-primary truncate">{getPathBasename(project.baseDir)}</span>
                        <Checkbox
                          checked={isEnabled}
                          onChange={(checked) => handleToggleProject(project, selectedWorkflow.id, checked)}
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
      </div>
    </div>
  );
};

export default WorkflowsSettings;
