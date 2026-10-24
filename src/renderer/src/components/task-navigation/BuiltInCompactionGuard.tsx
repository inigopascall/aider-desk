import { ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { taskHasTopicCompactions } from '@common/types';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useProjectStore } from '@/stores/projectStore';

type PendingCommand = {
  command: string;
  run: () => void;
};

export type BuiltInCompactionGuard = {
  /** Runs a built-in compaction command at once, or after a confirmation when the task has compacted topics or sections. */
  guardBuiltInCompaction: (command: string, run: () => void) => void;
  /** The confirmation dialog while it is open, otherwise null. */
  builtInCompactionDialog: ReactNode;
};

/**
 * Prompt field: `/compact` and `/hone` archive the full conversation first, and compacted topics can't be undone until
 * that archive is restored, so a task with compactions asks before running them.
 */
export const useBuiltInCompactionGuard = (baseDir: string, taskId: string): BuiltInCompactionGuard => {
  const { t } = useTranslation();
  const hasCompactions = useProjectStore((state) => {
    const task = state.projectTasksMap.get(baseDir)?.find((item) => item.id === taskId);
    return task ? taskHasTopicCompactions(task) : false;
  });
  const [pending, setPending] = useState<PendingCommand | null>(null);

  const guardBuiltInCompaction = useCallback(
    (command: string, run: () => void) => {
      if (hasCompactions) {
        setPending({ command, run });
      } else {
        run();
      }
    },
    [hasCompactions],
  );

  const handleConfirm = () => {
    if (pending) {
      setPending(null);
      pending.run();
    }
  };

  const builtInCompactionDialog = pending ? (
    <ConfirmDialog
      title={t('taskNavigation.compaction.builtIn.title')}
      onConfirm={handleConfirm}
      onCancel={() => setPending(null)}
      confirmButtonText={t('taskNavigation.compaction.builtIn.confirm')}
      closeOnEscape
    >
      <p className="text-sm text-text-primary">{t('taskNavigation.compaction.builtIn.text', { command: pending.command })}</p>
    </ConfirmDialog>
  ) : null;

  return { guardBuiltInCompaction, builtInCompactionDialog };
};
