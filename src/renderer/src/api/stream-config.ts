/**
 * Dependency-free module that holds the current stream configuration
 * (coalesced vs. live mode and flush interval) and notifies listeners
 * when it changes. This allows the BrowserApi to dynamically re-subscribe
 * to the server with updated parameters whenever settings change.
 */

export type StreamMode = 'live' | 'coalesced';

export interface StreamConfig {
  streamMode: StreamMode;
  streamFlushIntervalMs: number;
}

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  streamMode: 'coalesced',
  streamFlushIntervalMs: 2500,
};

let current: StreamConfig = { ...DEFAULT_STREAM_CONFIG };
const listeners = new Set<() => void>();

/**
 * Returns the current stream configuration.
 */
export const getStreamConfig = (): StreamConfig => current;

/**
 * Updates the stream configuration. If the new values are identical to the
 * current ones, this is a no-op. Otherwise, all registered listeners are notified.
 */
export const setStreamConfig = (next: StreamConfig): void => {
  if (next.streamMode === current.streamMode && next.streamFlushIntervalMs === current.streamFlushIntervalMs) {
    return;
  }
  current = { ...next };
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore broken listeners
    }
  }
};

/**
 * Registers a listener that fires whenever the stream config changes.
 * Returns an unsubscribe function.
 */
export const onStreamConfigChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
