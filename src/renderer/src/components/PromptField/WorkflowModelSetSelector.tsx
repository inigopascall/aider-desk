import { DEFAULT_WORKFLOW_MODEL_SET_ID, TaskData } from '@common/types';

import { useApi } from '@/contexts/ApiContext';
import { useSettingsStore } from '@/stores/settingsStore';
import { useProjectSettings } from '@/contexts/ProjectSettingsContext';

type Props = {
  baseDir: string;
  task: TaskData;
  selectedWorkflowId: string | null;
};

export const WorkflowModelSetSelector = ({ baseDir, task, selectedWorkflowId }: Props) => {
  const settings = useSettingsStore((state) => state.settings);
  const { projectSettings } = useProjectSettings();
  const api = useApi();

  if (!selectedWorkflowId) return null;

  const sets = (settings?.workflowModelSets?.[selectedWorkflowId] ?? []).filter((s) => s.id !== DEFAULT_WORKFLOW_MODEL_SET_ID);
  if (sets.length === 0) return null;

  const taskSetId = task.workflowModelSetIds?.[selectedWorkflowId];
  const projectSetId = projectSettings?.workflowModelSetIds?.[selectedWorkflowId];
  const resolved = taskSetId ?? projectSetId ?? DEFAULT_WORKFLOW_MODEL_SET_ID;
  const value = resolved === DEFAULT_WORKFLOW_MODEL_SET_ID || sets.some((s) => s.id === resolved) ? resolved : DEFAULT_WORKFLOW_MODEL_SET_ID;
  const isFromProject = !taskSetId && !!projectSetId && (projectSetId === DEFAULT_WORKFLOW_MODEL_SET_ID || sets.some((set) => set.id === projectSetId));

  const handleChange = async (newValue: string) => {
    const current = task.workflowModelSetIds ?? {};
    const next = { ...current, [selectedWorkflowId]: newValue };
    await api.updateTask(baseDir, task.id, { workflowModelSetIds: next });
  };

  return (
    <select
      className="h-[26px] text-2xs bg-bg-secondary border border-border-default rounded-md pl-1.5 pr-2 text-text-primary cursor-pointer focus:outline-none focus:border-border-light"
      value={value}
      onChange={(e) => void handleChange(e.target.value)}
      title={isFromProject ? 'Project default (click to override for this task)' : 'Model set for this task'}
    >
      <option value={DEFAULT_WORKFLOW_MODEL_SET_ID}>Default</option>
      {sets.map((set) => (
        <option key={set.id} value={set.id}>
          {set.name}
        </option>
      ))}
    </select>
  );
};

export default WorkflowModelSetSelector;
