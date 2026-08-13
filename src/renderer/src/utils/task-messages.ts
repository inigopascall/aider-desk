import { v4 as uuidv4 } from 'uuid';
import { TODO_TOOL_GROUP_NAME } from '@common/tools';
import {
  Message,
  ReflectedMessage,
  ResponseCompletedData,
  ResponseMessage,
  TaskStateData,
  ToolData,
  ToolMessage,
  UserMessage,
  UserMessageData,
  WorkflowLogData,
  WorkflowLogMessage,
} from '@common/types';

const convertUserMessage = (data: UserMessageData): UserMessage => ({
  id: data.id,
  type: 'user',
  content: data.content,
  images: data.images,
  promptContext: data.promptContext,
  timestamp: data.timestamp,
});

const convertResponse = (data: ResponseCompletedData): Message[] => {
  const messages: Message[] = [];
  if (data.reflectedMessage) {
    const reflected: ReflectedMessage = {
      id: uuidv4(),
      type: 'reflected-message',
      content: data.reflectedMessage,
      responseMessageId: data.messageId,
      promptContext: data.promptContext,
      timestamp: data.timestamp,
    };
    messages.push(reflected);
  }

  const response: ResponseMessage = {
    id: data.messageId,
    type: 'response',
    content: data.content,
    reasoning: data.reasoning,
    usageReport: data.usageReport,
    promptContext: data.promptContext,
    finished: true,
    timestamp: data.timestamp,
  };
  messages.push(response);
  return messages;
};

const convertTool = (data: ToolData): ToolMessage => ({
  id: data.id,
  type: 'tool',
  serverName: data.serverName,
  toolName: data.toolName,
  args: (data.args as Record<string, unknown> | undefined) ?? {},
  content: data.response ?? '',
  usageReport: data.usageReport,
  promptContext: data.promptContext,
  finished: data.finished,
  timestamp: data.timestamp,
});

export const convertTaskStateMessages = (messages: TaskStateData['messages']): Message[] => {
  return messages.flatMap((message) => {
    if (message.type === 'user') {
      return [convertUserMessage(message)];
    }
    if (message.type === 'response-completed') {
      return convertResponse(message);
    }
    if (message.serverName === TODO_TOOL_GROUP_NAME) {
      return [];
    }
    return [convertTool(message)];
  });
};

export const convertWorkflowLogToMessage = (log: WorkflowLogData): WorkflowLogMessage => ({
  id: log.id,
  type: 'workflow-log',
  content: log.message,
  level: log.level,
  runId: log.runId,
  workflowId: log.workflowId,
  workflowName: log.workflowName,
  actionIds: log.actionIds,
  finished: log.finished,
  promptContext: log.promptContext,
  timestamp: log.timestamp,
  sequence: log.sequence,
});

export const mergeWorkflowLogs = (messages: Message[], logs?: WorkflowLogData[]): Message[] => {
  if (!logs || logs.length === 0) return messages;
  const workflowMessages = logs.map(convertWorkflowLogToMessage);
  return [...messages, ...workflowMessages].sort((a, b) => {
    const ta = a.timestamp ?? 0;
    const tb = b.timestamp ?? 0;
    if (ta !== tb) return ta - tb;
    const sa = (a as WorkflowLogMessage).sequence ?? 0;
    const sb = (b as WorkflowLogMessage).sequence ?? 0;
    return sa - sb;
  });
};
