/**
 * Bridges into the task navigation module. EventManager reports every broadcast event here, and ContextManager reports
 * every replacement of a task's conversation; the task navigation manager registers the listeners when it starts.
 * This file must not import anything.
 */
export type TaskNavigationEventListener = (eventType: string, data: unknown) => void;

export type TaskNavigationContextReplaceListener = (baseDir: string, taskId: string, previousMessages: unknown[], nextMessages: unknown[]) => void;

let eventListener: TaskNavigationEventListener | null = null;
let contextReplaceListener: TaskNavigationContextReplaceListener | null = null;

export const setTaskNavigationEventListener = (listener: TaskNavigationEventListener | null): void => {
  eventListener = listener;
};

export const notifyTaskNavigationEvent = (eventType: string, data: unknown): void => {
  if (!eventListener) {
    return;
  }
  try {
    eventListener(eventType, data);
  } catch {
    // Task navigation must never interfere with event delivery.
  }
};

export const setTaskNavigationContextReplaceListener = (listener: TaskNavigationContextReplaceListener | null): void => {
  contextReplaceListener = listener;
};

/** Called synchronously before a task's whole conversation is replaced, with the messages before and after. */
export const notifyTaskNavigationContextReplace = (baseDir: string, taskId: string, previousMessages: unknown[], nextMessages: unknown[]): void => {
  if (!contextReplaceListener) {
    return;
  }
  try {
    contextReplaceListener(baseDir, taskId, previousMessages, nextMessages);
  } catch {
    // Task navigation must never interfere with context changes.
  }
};
