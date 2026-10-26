import { TaskData } from '@common/types';

import { ReasoningSelector } from './ReasoningSelector';
import { TemperatureSelector } from './TemperatureSelector';

import { useEffectiveModelSettings } from '@/hooks/useEffectiveModelSettings';

type Props = {
  task: TaskData;
  updateTask: (taskId: string, updates: Partial<TaskData>, useOptimistic?: boolean) => void;
  disabled?: boolean;
};

/** Per-task Reasoning and Temperature controls for the agent model, each showing the value that will be sent and where it comes from. */
export const TaskModelSettingsControls = ({ task, updateTask, disabled }: Props) => {
  const settings = useEffectiveModelSettings(task);

  if (!settings) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 flex-shrink-0">
      <ReasoningSelector
        reasoning={settings.reasoning}
        agentProfileName={settings.agentProfileName}
        disabled={disabled}
        onChange={(reasoningOverride) => updateTask(task.id, { reasoningOverride })}
      />
      <TemperatureSelector
        temperature={settings.temperature}
        agentProfileName={settings.agentProfileName}
        disabled={disabled}
        onChange={(temperatureOverride) => updateTask(task.id, { temperatureOverride })}
      />
    </div>
  );
};
