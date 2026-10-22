/**
 * Bridge between EventManager and the task navigation module. EventManager reports every broadcast event here;
 * the task navigation manager registers the listener when it starts. This file must not import anything.
 */
export type TaskNavigationEventListener = (eventType: string, data: unknown) => void;

let eventListener: TaskNavigationEventListener | null = null;

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
