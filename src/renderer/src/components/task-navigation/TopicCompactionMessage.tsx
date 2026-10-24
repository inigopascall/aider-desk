import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { CgSpinner } from 'react-icons/cg';
import { MdUndo } from 'react-icons/md';
import { DefaultTaskState, ResponseMessage, getTaskSummary, getTopicCompactionIdFromMessageId } from '@common/types';

import { findTopicCompaction, getCompactionErrorText } from './compaction-utils';
import { isCompactingPlaceholderId, isTopicCompactionRecapId } from './compaction-view';

import { ResponseMessageBlock } from '@/components/message/ResponseMessageBlock';
import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { useProjectStore } from '@/stores/projectStore';
import { showErrorNotification } from '@/utils/notifications';

export type TopicCompactionMessageProps = {
  baseDir: string;
  taskId: string;
  message: ResponseMessage;
  allFiles: string[];
  renderMarkdown: boolean;
  compact?: boolean;
  showThinking?: boolean;
  hideMessageBar?: boolean;
};

/** The "Compacting…" line shown in place of a stretch of messages while it is compacted. */
export const TopicCompactingPlaceholder = ({ compact = false }: { compact?: boolean }) => {
  const { t } = useTranslation();
  return (
    <div
      data-message-block
      className={clsx(
        'rounded-md max-w-full text-xs bg-bg-secondary text-text-secondary flex items-center gap-2',
        !compact && 'p-3 border border-border-dark-light',
      )}
    >
      <CgSpinner className="w-4 h-4 shrink-0 animate-spin text-text-muted" />
      <span>{t('taskNavigation.compaction.compacting')}</span>
    </div>
  );
};

/** The recap of a compacted topic or section: one AI message with a badge and an Undo button, without remove or fork. */
export const TopicCompactionRecap = ({
  baseDir,
  taskId,
  message,
  allFiles,
  renderMarkdown,
  compact = false,
  showThinking = true,
  hideMessageBar = false,
}: TopicCompactionMessageProps) => {
  const { t } = useTranslation();
  const api = useApi();
  const task = useProjectStore((state) => state.projectTasksMap.get(baseDir)?.find((item) => item.id === taskId));
  const [undoing, setUndoing] = useState(false);

  const compactionId = getTopicCompactionIdFromMessageId(message.id);
  const summary = task ? getTaskSummary(task) : undefined;
  const found = compactionId && summary ? findTopicCompaction(summary.topics, compactionId) : undefined;
  const running = task?.state === DefaultTaskState.InProgress;
  const blockedByTopic = found?.sectionIndex !== undefined && found.topicCompacted;
  const undoDisabled = !compactionId || running || blockedByTopic || undoing;

  const undoTooltip = running
    ? t('taskNavigation.compaction.taskRunning')
    : blockedByTopic
      ? t('taskNavigation.compaction.undoTopicFirst')
      : t('taskNavigation.compaction.undo');
  const badge = found
    ? t('taskNavigation.compaction.badge', { level: found.compaction.level, count: found.compaction.messageCount })
    : t('taskNavigation.compaction.badgeUnknown');

  const handleUndo = async () => {
    if (!compactionId || undoDisabled) {
      return;
    }
    setUndoing(true);
    try {
      await api.undoTopicCompaction(baseDir, taskId, compactionId);
    } catch (error) {
      const text = getCompactionErrorText(error, 'taskNavigation.compaction.undoFailed');
      showErrorNotification(t(text.key, text.values));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-2xs text-text-muted">
        <span className="px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">{badge}</span>
        <Tooltip content={undoTooltip}>
          <span className="inline-flex">
            <button
              type="button"
              aria-label={t('taskNavigation.compaction.undo')}
              disabled={undoDisabled}
              onClick={() => void handleUndo()}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <MdUndo className="w-3.5 h-3.5" />
              <span>{t('taskNavigation.compaction.undoShort')}</span>
            </button>
          </span>
        </Tooltip>
      </div>
      <ResponseMessageBlock
        baseDir={baseDir}
        message={message}
        allFiles={allFiles}
        renderMarkdown={renderMarkdown}
        compact={compact}
        showThinking={showThinking}
        hideMessageBar={hideMessageBar}
      />
    </div>
  );
};

/** Renders a recap or a "Compacting…" placeholder; null for every other response message. */
export const renderTopicCompactionMessage = (props: TopicCompactionMessageProps): ReactNode => {
  if (isCompactingPlaceholderId(props.message.id)) {
    return <TopicCompactingPlaceholder compact={props.compact} />;
  }
  if (isTopicCompactionRecapId(props.message.id)) {
    return <TopicCompactionRecap {...props} />;
  }
  return null;
};
