import { TaskData, getTaskKey, getTaskSummary } from '@common/types';

import { useTaskNavigationSettings } from './hooks';
import { TaskSummaryPreview } from './TaskSummaryPreview';

import { Tooltip } from '@/components/ui/Tooltip';

const PREVIEW_TOPIC_COUNT = 8;

type Props = {
  task: TaskData;
  taskName: string;
  showNameTooltip: boolean;
};

/** Task name in the sidebar: prefixed with the task key, with the topic map as its hover preview. */
export const TaskNamePreview = ({ task, taskName, showNameTooltip }: Props) => {
  const settings = useTaskNavigationSettings();
  const taskKey = getTaskKey(task, settings);
  const summary = getTaskSummary(task);
  const fullName = taskKey ? `${taskKey}: ${taskName}` : taskName;
  const label = (
    <span>
      {taskKey && <span className="mr-1 text-text-muted">{`${taskKey}:`}</span>}
      {taskName}
    </span>
  );

  if (summary && summary.topics.length > 0) {
    return (
      <Tooltip
        content={<TaskSummaryPreview summary={summary} title={fullName} maxTopics={PREVIEW_TOPIC_COUNT} />}
        delayDuration={600}
        maxWidth="440px"
        side="right"
      >
        {label}
      </Tooltip>
    );
  }

  if (showNameTooltip) {
    return (
      <Tooltip content={fullName} delayDuration={1000}>
        {label}
      </Tooltip>
    );
  }

  return label;
};
