import { createContext, ReactNode, useContext } from 'react';

const MessagesTaskContext = createContext<string | undefined>(undefined);

export const MessagesTaskProvider = ({ taskId, children }: { taskId: string; children: ReactNode }) => (
  <MessagesTaskContext.Provider value={taskId}>{children}</MessagesTaskContext.Provider>
);

/** Returns undefined outside a thread (e.g. extension-rendered previews). */
export const useMessagesTaskId = () => useContext(MessagesTaskContext);