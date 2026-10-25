import { useTranslation } from 'react-i18next';
import { FiMap } from 'react-icons/fi';
import { clsx } from 'clsx';

import { IconButton } from '@/components/common/IconButton';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';

export const TopicMapToggleButton = () => {
  const { t } = useTranslation();
  const topicMapOpen = useTaskNavigationStore((state) => state.topicMapOpen);
  const toggleTopicMap = useTaskNavigationStore((state) => state.toggleTopicMap);

  return (
    <IconButton
      icon={<FiMap className="w-4 h-4" />}
      onClick={toggleTopicMap}
      tooltip={t('taskNavigation.topicMap.toggle')}
      className={clsx('p-1 rounded-md hover:bg-bg-tertiary', topicMapOpen && 'text-text-primary bg-bg-tertiary')}
      data-testid="topic-map-toggle"
    />
  );
};
