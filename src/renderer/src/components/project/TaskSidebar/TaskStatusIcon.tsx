import { DefaultTaskState } from '@common/types';
import { clsx } from 'clsx';

import { TaskActivityIndicator } from '@/components/common/TaskActivityIndicator';
import { useTaskQuestion } from '@/stores/taskStore';

type Props = {
  taskId: string;
  state?: string;
  isCollapsed?: boolean;
};

export const TaskStatusIcon = ({ taskId, state, isCollapsed }: Props) => {
  const question = useTaskQuestion(taskId);
  if (question) {
    return <span className={clsx('text-text-primary', isCollapsed ? 'text-xs' : 'text-sm')}>?</span>;
  }
  return state === DefaultTaskState.InProgress ? <TaskActivityIndicator active className="ml-8" /> : null;
};
