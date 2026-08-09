import { AVAILABLE_WORKFLOWS, SettingsData, TaskData } from '@common/types';

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

  const sets = settings?.workflowModelSets?.[selectedWorkflowId] ?? [];
  if (sets.length === 0) return null;

  const taskSetId = task.workflowModelSetIds?.[selectedWorkflowId];
  const projectSetId = projectSettings?.workflowModelSetIds?.[selectedWorkflowId];
  const resolved = taskSetId ?? projectSetId ?? '';
  const value = sets.some((s) => s.id === resolved) ? resolved : '';
  const isFromProject = !taskSetId && !!projectSetId;

  const handleChange = async (newValue: string) => {
    const current = task.workflowModelSetIds ?? {};
    const next = { ...current };
    if (newValue) {
      next[selectedWorkflowId] = newValue;
    } else {
      delete next[selectedWorkflowId];
    }
    await api.updateTask(baseDir, task.id, { workflowModelSetIds: next });
  };

  return (
    <select
      className="h-[26px] text-2xs bg-bg-secondary border border-border-default rounded-md px-1 text-text-primary focus:outline-none focus:border-border-light"
      value={value}
      onChange={(e) => void handleChange(e.target.value)}
      title={isFromProject ? 'Project default (click to override for this task)' : 'Model set for this task'}
    >
      <option value="">Default</option>
      {sets.map((set) => (
        <option key={set.id} value={set.id}>
          {set.name}
        </option>
      ))}
    </select>
  );
};

export default WorkflowModelSetSelector;
