import { DefaultTaskState } from '@common/types';
import { CgSpinner } from 'react-icons/cg';
import { clsx } from 'clsx';

import { TaskActivityIndicator } from '@/components/common/TaskActivityIndicator';
import { useTaskQuestion } from '@/stores/taskStore';
import { useSettingsStore } from '@/stores/settingsStore';

type Props = {
  taskId: string;
  state?: string;
  isCollapsed?: boolean;
  showSpinner?: boolean;
};

export const TaskStatusIcon = ({ taskId, state, isCollapsed, showSpinner }: Props) => {
  const question = useTaskQuestion(taskId);
  const disableCssStreamingAnimations = useSettingsStore((store) => store.settings?.disableCssStreamingAnimations ?? true);
  if (question) {
    return <span className={clsx('text-text-primary', isCollapsed ? 'text-xs' : 'text-sm')}>?</span>;
  }
  if (state !== DefaultTaskState.InProgress && !showSpinner) {
    return null;
  }

  return disableCssStreamingAnimations ? (
    <TaskActivityIndicator active className="ml-0.5" />
  ) : (
    <CgSpinner className={clsx('ml-0.5 animate-spin', isCollapsed ? 'text-xs' : 'text-sm', 'text-text-primary')} />
  );
};
