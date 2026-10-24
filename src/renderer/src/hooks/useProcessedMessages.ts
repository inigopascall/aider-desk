import { useMemo } from 'react';
import { Message, MessageViewMode } from '@common/types';

import { groupAssistantMessages, groupMessagesByPromptContext } from '@/components/message/utils';
import { useTopicCompactionView } from '@/components/task-navigation/compaction-view';
import { useSettingsStore } from '@/stores/settingsStore';

export const useProcessedMessages = (messages: Message[]): Message[] => {
  const messageViewMode = useSettingsStore((state) => state.settings?.messageViewMode);
  const isCompactMode = messageViewMode === MessageViewMode.Compact;
  const visibleMessages = useTopicCompactionView(messages);

  return useMemo(() => {
    const grouped = groupMessagesByPromptContext(visibleMessages);
    return isCompactMode ? groupAssistantMessages(grouped) : grouped;
  }, [visibleMessages, isCompactMode]);
};