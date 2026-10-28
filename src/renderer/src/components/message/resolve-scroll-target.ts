import { isAssistantGroupMessage, isGroupMessage, Message } from '@common/types';

export const resolveTopLevelMessageId = (processed: Message[], id: string): string | undefined => {
  const visit = (message: Message, topLevelId: string): string | undefined => {
    if (message.id === id) {
      return topLevelId;
    }
    if (isGroupMessage(message)) {
      for (const child of message.children) {
        const found = visit(child, topLevelId);
        if (found) {
          return found;
        }
      }
    } else if (isAssistantGroupMessage(message)) {
      const response = visit(message.responseMessage, topLevelId);
      if (response) {
        return response;
      }
      for (const tool of message.toolMessages) {
        const found = visit(tool, topLevelId);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };

  for (const message of processed) {
    if (message.id === id) {
      return message.id;
    }
  }
  for (const message of processed) {
    const found = visit(message, message.id);
    if (found) {
      return found;
    }
  }
  return undefined;
};
