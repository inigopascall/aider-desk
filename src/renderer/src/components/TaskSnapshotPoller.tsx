import { useEffect } from 'react';

import { setMessages, updateTaskState } from '@/stores/taskStore';
import { useApi } from '@/contexts/ApiContext';
import { convertTaskStateMessages } from '@/utils/task-messages';

const POLL_INTERVAL_MS = 5000;

/**
 * Replaces TaskEventSubscriber when a task is in snapshot mode.
 *
 * Instead of setting up socket event listeners (which fire 10-60 times/sec
 * during streaming and cause continuous React re-renders), this component
 * polls api.loadTask() every 5 seconds and replaces the entire message
 * store with the result.
 *
 * Between polls, the browser does absolutely nothing for this task —
 * no socket events, no store updates, no re-renders, no GPU compositing.
 */
export const TaskSnapshotPoller = ({ baseDir, taskId }: { baseDir: string; taskId: string }) => {
  const api = useApi();

  useEffect(() => {
    const poll = async () => {
      try {
        const { messages: stateMessages, files, todoItems, question, queuedPrompts } = await api.loadTask(baseDir, taskId);
        const messages = convertTaskStateMessages(stateMessages);
        setMessages(taskId, () => messages);
        updateTaskState(taskId, {
          loaded: true,
          contextFiles: files,
          todoItems: todoItems || [],
          question,
          queuedPrompts,
        });
      } catch {
        // Silently ignore — the next poll will retry
      }
    };

    // Poll immediately, then on interval
    void poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [api, baseDir, taskId]);

  return null;
};
