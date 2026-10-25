import { TaskSummary } from '@common/types';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

type Props = {
  summary: TaskSummary;
  title?: string;
  /** Shows only the most recent topics, with a note about the earlier ones. */
  maxTopics?: number;
  className?: string;
};

type TaskDescriptionProps = {
  description: string;
  /** Text size and spacing classes. */
  className?: string;
};

/** The task's description, set apart above its topics in a warning colour. */
export const TaskDescription = ({ description, className }: TaskDescriptionProps) => (
  <p className={clsx('border-l-2 border-warning pl-2 font-medium leading-snug text-warning-light', className)}>{description}</p>
);

export const TaskSummaryPreview = ({ summary, title, maxTopics, className }: Props) => {
  const { t } = useTranslation();
  const topics = summary.topics;
  const start = maxTopics !== undefined && topics.length > maxTopics ? topics.length - maxTopics : 0;

  return (
    <div className={clsx('flex flex-col gap-1 min-w-0', className)}>
      {title && <div className="text-xs font-semibold text-text-primary">{title}</div>}
      {summary.description && <TaskDescription description={summary.description} className="mb-0.5 text-2xs" />}
      {start > 0 && <div className="text-2xs italic text-text-muted">{t('taskNavigation.earlierTopics', { count: start })}</div>}
      <ol className="flex flex-col gap-0.5">
        {topics.slice(start).map((topic, offset) => {
          const index = start + offset;
          return (
            <li key={index} className={clsx('flex items-start gap-1.5 text-2xs', topic.detached && 'opacity-60')}>
              <span className="w-5 shrink-0 text-right text-text-muted">{`${index + 1}.`}</span>
              <span className="flex-1 min-w-0 text-text-secondary">{topic.summary}</span>
              <span className="shrink-0 text-text-muted">{t('taskNavigation.messageCount', { count: topic.messageIds.length })}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
