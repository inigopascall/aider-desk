import { useMemo, useRef, useState } from 'react';
import { MdKeyboardArrowUp } from 'react-icons/md';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { DEFAULT_WORKFLOW_MODEL_SET_ID, AVAILABLE_WORKFLOWS, TaskData, WorkflowModelSet } from '@common/types';
import { buildDefaultWorkflowModelSet, getWorkflowModelSetLabel } from '@common/agent';

import { useApi } from '@/contexts/ApiContext';
import { useSettingsStore } from '@/stores/settingsStore';
import { useProjectSettings } from '@/contexts/ProjectSettingsContext';
import { useAgents } from '@/contexts/AgentsContext';
import { useClickOutside } from '@/hooks/useClickOutside';

type Props = {
  baseDir: string;
  task: TaskData;
  selectedWorkflowId: string | null;
};

export const WorkflowModelSetSelector = ({ baseDir, task, selectedWorkflowId }: Props) => {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const { projectSettings } = useProjectSettings();
  const { getWorkflowAgentProfiles } = useAgents();
  const api = useApi();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  if (!selectedWorkflowId) return null;

  const allSets = settings?.workflowModelSets?.[selectedWorkflowId] ?? [];
  const customSets = allSets.filter((s) => s.id !== DEFAULT_WORKFLOW_MODEL_SET_ID);
  if (customSets.length === 0) return null;

  const workflowInfo = AVAILABLE_WORKFLOWS.find((w) => w.id === selectedWorkflowId);
  const persistedDefault = allSets.find((s) => s.id === DEFAULT_WORKFLOW_MODEL_SET_ID);
  const defaultSet: WorkflowModelSet =
    persistedDefault ?? buildDefaultWorkflowModelSet(workflowInfo?.agents ?? [], getWorkflowAgentProfiles());
  const options = useMemo(() => [defaultSet, ...customSets], [defaultSet, customSets]);

  const taskSetId = task.workflowModelSetIds?.[selectedWorkflowId];
  const projectSetId = projectSettings?.workflowModelSetIds?.[selectedWorkflowId];
  const resolved = taskSetId ?? projectSetId ?? DEFAULT_WORKFLOW_MODEL_SET_ID;
  const value = resolved === DEFAULT_WORKFLOW_MODEL_SET_ID || customSets.some((s) => s.id === resolved) ? resolved : DEFAULT_WORKFLOW_MODEL_SET_ID;
  const isFromProject = !taskSetId && !!projectSetId && (projectSetId === DEFAULT_WORKFLOW_MODEL_SET_ID || customSets.some((set) => set.id === projectSetId));

  const labelFor = (set: WorkflowModelSet): string =>
    getWorkflowModelSetLabel({
      ...set,
      name: set.id === DEFAULT_WORKFLOW_MODEL_SET_ID ? t('workflowsSettings.defaultSetName') : set.name,
    });

  const selectedDisplayName = labelFor(options.find((set) => set.id === value) ?? defaultSet);

  const handleChange = async (setId: string) => {
    const current = task.workflowModelSetIds ?? {};
    const next = { ...current, [selectedWorkflowId]: setId };
    await api.updateTask(baseDir, task.id, { workflowModelSetIds: next });
    setIsOpen(false);
  };

  useClickOutside(containerRef, () => setIsOpen(false), isOpen);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        title={isFromProject ? t('workflowsSettings.projectDefaultModelSetTooltip') : t('workflowsSettings.taskModelSetTooltip')}
        className="h-[26px] max-w-[160px] flex items-center gap-1 text-2xs bg-bg-secondary border border-border-default rounded-md pl-2 pr-1.5 text-text-primary hover:border-border-light focus:outline-none"
      >
        <span className="truncate">{selectedDisplayName}</span>
        <MdKeyboardArrowUp className="w-3 h-3 flex-shrink-0" />
      </button>
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 z-50 min-w-full w-max max-w-[480px] max-h-60 overflow-y-auto bg-bg-primary-light border border-border-default-dark rounded-md shadow-lg scrollbar-thin scrollbar-track-transparent scrollbar-thumb-bg-tertiary">
          {options.map((set) => (
            <button
              key={set.id}
              onClick={() => void handleChange(set.id)}
              className={clsx(
                'block w-full text-left px-3 py-1 text-2xs whitespace-nowrap hover:bg-bg-tertiary transition-colors',
                set.id === value ? 'text-text-primary' : 'text-text-tertiary',
              )}
            >
              {labelFor(set)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default WorkflowModelSetSelector;
