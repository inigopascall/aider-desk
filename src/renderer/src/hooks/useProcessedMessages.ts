import { useMemo } from 'react';
import { Message, MessageViewMode } from '@common/types';

import { groupAssistantMessages, groupMessagesByPromptContext } from '@/components/message/utils';
import { useSettingsStore } from '@/stores/settingsStore';

export const useProcessedMessages = (messages: Message[]): Message[] => {
  const messageViewMode = useSettingsStore((state) => state.settings?.messageViewMode);
  const isCompactMode = messageViewMode === MessageViewMode.Compact;

  return useMemo(() => {
    const grouped = groupMessagesByPromptContext(messages);
    return isCompactMode ? groupAssistantMessages(grouped) : grouped;
  }, [messages, isCompactMode]);
};