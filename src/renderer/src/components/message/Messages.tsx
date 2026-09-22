import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { toPng } from 'html-to-image';
import { MdKeyboardDoubleArrowDown } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { GroupMessage, isAssistantGroupMessage, isGroupMessage, isLoadingMessage, isResponseMessage, isUserMessage, Message } from '@common/types';

import { MessageBlockWrapper } from './MessageBlockWrapper';
import { flashMessageElement } from './outline';

import { useScrollingPaused } from '@/hooks/useScrollingPaused';
import { useUserMessageNavigation } from '@/hooks/useUserMessageNavigation';
import { MessagesTaskProvider } from '@/contexts/MessagesTaskContext';
import { useProcessedMessages } from '@/hooks/useProcessedMessages';
import { composeMessagesWithWorkflowRuns } from '@/utils/workflow-messages';
import { EMPTY_WORKFLOW_RUNS, WorkflowRunState } from '@/stores/taskStore';

export type MessagesRef = {
  exportToImage: () => void;
  scrollToBottom: () => void;
  scrollToMessage: (messageId: string) => void;
};

type Props = {
  baseDir: string;
  taskId: string;
  inProgress: boolean;
  messages: Message[];
  workflowRuns?: WorkflowRunState[];
  allFiles?: string[];
  renderMarkdown: boolean;
  onContainerRef?: (container: HTMLDivElement | null) => void;
  removeMessage?: (message: Message) => void;
  removeGroup?: (group: GroupMessage) => void;
  redoUserPrompt?: (messageId: string) => void;
  editUserMessage?: (messageId: string, content: string, images?: string[]) => void;
  onInterrupt?: () => void;
  onForkFromMessage?: (message: Message) => void;
  onRemoveUpToMessage?: (message: Message) => void;
};

const MessagesComponent = forwardRef<MessagesRef, Props>(
  (
    {
      baseDir,
      taskId,
      inProgress,
      messages,
      workflowRuns,
      allFiles = [],
      renderMarkdown,
      onContainerRef,
      removeMessage,
      removeGroup,
      redoUserPrompt,
      editUserMessage,
      onInterrupt,
      onForkFromMessage,
      onRemoveUpToMessage,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);

    const activityMessageId = useMemo(() => {
      if (!inProgress) {
        return undefined;
      }

      let latestActivityMessageId: string | undefined;

      const visitMessage = (message: Message) => {
        if (isGroupMessage(message)) {
          message.children.forEach(visitMessage);
          return;
        }

        if (isAssistantGroupMessage(message)) {
          visitMessage(message.responseMessage);
          message.toolMessages.forEach(visitMessage);
          return;
        }

        if (isLoadingMessage(message) || (isResponseMessage(message) && !message.finished)) {
          latestActivityMessageId = message.id;
        }
      };

      messages.forEach(visitMessage);

      return latestActivityMessageId;
    }, [inProgress, messages]);

    const timelineMessages = useMemo(
      () => composeMessagesWithWorkflowRuns(messages, workflowRuns ?? EMPTY_WORKFLOW_RUNS),
      [messages, workflowRuns],
    );
    const processedMessages = useProcessedMessages(timelineMessages);

    const { scrollingPaused, setScrollingPaused, scrollToBottom, eventHandlers } = useScrollingPaused({
      onAutoScroll: () => messagesEndRef.current?.scrollIntoView(),
    });

    useEffect(() => {
      if (!scrollingPaused) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({
            block: 'end',
            inline: 'end',
            behavior: 'instant',
          });
        });
      }
    }, [processedMessages, scrollingPaused]);

    // Get all user message IDs
    const userMessageIds = useMemo(() => {
      return processedMessages.filter(isUserMessage).map((message) => message.id);
    }, [processedMessages]);

    const { hasPreviousUserMessage, hasNextUserMessage, renderGoToPrevious, renderGoToNext } = useUserMessageNavigation({
      containerRef: messagesContainerRef,
      userMessageIds,
      scrollToMessageByElement: (element: HTMLElement) => {
        setScrollingPaused(true);
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      buttonClassName: 'hidden group-hover:block',
    });

    useEffect(() => {
      onContainerRef?.(messagesContainerRef.current);
    }, [onContainerRef]);

    const exportToImage = useCallback(async () => {
      const messagesContainer = messagesContainerRef.current;
      if (messagesContainer === null) {
        return;
      }

      try {
        const dataUrl = await toPng(messagesContainer, {
          cacheBust: true,
          height: messagesContainer.scrollHeight,
        });
        const link = document.createElement('a');
        link.download = `session-${new Date().toISOString().replace(/:/g, '-').substring(0, 19)}.png`;
        link.href = dataUrl;
        link.click();
        link.remove();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to export chat as PNG', err);
      }
    }, []);

    const scrollToMessage = (messageId: string) => {
      setScrollingPaused(true);
      const element = messagesContainerRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        flashMessageElement(element);
      }
    };

    useImperativeHandle(ref, () => ({
      exportToImage,
      container: messagesContainerRef.current,
      scrollToBottom,
      scrollToMessage,
    }));

    return (
      <MessagesTaskProvider taskId={taskId}>
        <div className="relative flex flex-col h-full">
          <div
            ref={messagesContainerRef}
            className="flex flex-col flex-grow overflow-y-auto max-h-full p-4 pb-2 scrollbar-thin scrollbar-track-bg-primary-light scrollbar-thumb-bg-tertiary hover:scrollbar-thumb-bg-fourth space-y-2"
            {...eventHandlers}
          >
            {processedMessages.map((message) => (
              <div key={message.id} data-message-id={message.id}>
                <MessageBlockWrapper
                  baseDir={baseDir}
                  taskId={taskId}
                  message={message}
                  allFiles={allFiles}
                  renderMarkdown={renderMarkdown}
                  inProgress={inProgress}
                  removeMessage={removeMessage}
                  removeGroup={removeGroup}
                  redoUserPrompt={redoUserPrompt}
                  editUserMessage={editUserMessage}
                  onInterrupt={onInterrupt}
                  onForkFromMessage={onForkFromMessage}
                  onRemoveUpToMessage={onRemoveUpToMessage}
                  activityMessageId={activityMessageId}
                />
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div className="relative">
            <div className="absolute left-1/2 -translate-x-1/2 bottom-0 w-[140px] z-10 flex justify-center gap-1 pt-6 pb-1 group">
              {(hasPreviousUserMessage || hasNextUserMessage) && renderGoToPrevious()}
              {scrollingPaused && (
                <IconButton
                  icon={<MdKeyboardDoubleArrowDown className="h-6 w-6" />}
                  onClick={scrollToBottom}
                  tooltip={t('messages.scrollToBottom')}
                  className="bg-bg-primary-light border border-border-default shadow-lg hover:bg-bg-secondary transition-colors duration-200"
                  aria-label={t('messages.scrollToBottom')}
                />
              )}
              {(hasPreviousUserMessage || hasNextUserMessage) && renderGoToNext()}
            </div>
          </div>
        </div>
      </MessagesTaskProvider>
    );
  },
);

MessagesComponent.displayName = 'Messages';

export const Messages = memo(MessagesComponent);
