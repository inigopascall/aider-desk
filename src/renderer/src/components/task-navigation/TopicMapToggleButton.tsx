import { useTranslation } from 'react-i18next';
import { MdToc } from 'react-icons/md';
import { clsx } from 'clsx';

import { IconButton } from '@/components/common/IconButton';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';

export const TopicMapToggleButton = () => {
  const { t } = useTranslation();
  const topicPanelOpen = useTaskNavigationStore((state) => state.topicPanelOpen);
  const toggleTopicPanel = useTaskNavigationStore((state) => state.toggleTopicPanel);

  return (
    <IconButton
      icon={<MdToc className="w-5 h-5" />}
      onClick={toggleTopicPanel}
      tooltip={t('taskNavigation.topicMap.toggle')}
      className={clsx('p-1 rounded-md hover:bg-bg-tertiary', topicPanelOpen && 'text-text-primary bg-bg-tertiary')}
      data-testid="topic-map-toggle"
    />
  );
};
