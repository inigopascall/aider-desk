/** Receives repository mappings events. */
export type RepositoryMappingsEventListener = (eventType: string, data: unknown) => void;

let eventListener: RepositoryMappingsEventListener | null = null;

export const setRepositoryMappingsEventListener = (listener: RepositoryMappingsEventListener | null): void => {
  eventListener = listener;
};

export const notifyRepositoryMappingsEvent = (eventType: string, data: unknown): void => {
  if (!eventListener) {
    return;
  }
  try {
    eventListener(eventType, data);
  } catch {
    // Mapping events must never interfere with event delivery.
  }
};
