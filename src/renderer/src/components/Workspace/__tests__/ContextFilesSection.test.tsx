import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextFilesSection } from '../ContextFilesSection';
import { normalizePath } from '../types';

import type { ContextFile } from '@common/types';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { ApiContext } from '@/contexts/ApiContext';
import { EMPTY_TASK_STATE, updateTaskState, useTaskStore } from '@/stores/taskStore';
import { showErrorNotification } from '@/utils/notifications';

vi.mock('@/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/notifications')>()),
  showErrorNotification: vi.fn(),
}));

vi.mock('@/stores/fileEditorStore', () => ({
  useFileEditorStore: (selector: (state: { openFile: (...args: unknown[]) => void }) => unknown) => selector({ openFile: vi.fn() }),
}));

vi.mock('../EmptyContextInfo', () => ({
  EmptyContextInfo: () => null,
}));

const BASE_DIR = '/project';
const TASK_ID = 'task-1';
const NO_FILES: ContextFile[] = [];

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const createDeferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const file = (path: string, disabled = false): ContextFile => (disabled ? { path, disabled: true } : { path });

const initialFiles = (): ContextFile[] => [file('a.ts'), file('b.ts'), file('c.ts', true)];

// Mirrors production: the section receives the task store's context files and a normalized path map.
const Harness = () => {
  const contextFiles = useTaskStore((state) => state.taskStateMap.get(TASK_ID)?.contextFiles ?? NO_FILES);
  const contextFilesMap = useMemo(
    () => new Map<string, ContextFile>(contextFiles.map((contextFile): [string, ContextFile] => [normalizePath(contextFile.path), contextFile])),
    [contextFiles],
  );

  return (
    <ContextFilesSection
      mode="agent"
      baseDir={BASE_DIR}
      taskId={TASK_ID}
      userContextFiles={contextFiles}
      isOpen={true}
      totalStats={{ additions: 0, deletions: 0 }}
      os={null}
      contextFilesMap={contextFilesMap}
      showFileDialog={() => undefined}
      onDropAllFiles={() => undefined}
      onToggle={() => undefined}
      onDropFile={() => () => undefined}
    />
  );
};

const renderSection = (files: ContextFile[]) => {
  const requests: Deferred[] = [];
  const api = createMockApi({
    setContextFilesDisabled: vi.fn(() => {
      const request = createDeferred();
      requests.push(request);
      return request.promise;
    }),
    refreshContextFiles: vi.fn(() => Promise.resolve()),
  });

  updateTaskState(TASK_ID, { ...EMPTY_TASK_STATE, loaded: true, contextFiles: files });
  render(
    <ApiContext.Provider value={api}>
      <Harness />
    </ApiContext.Provider>,
  );

  return { api, requests };
};

// Simulates a context-files-updated event from the backend.
const setStoreFiles = (files: ContextFile[]) => {
  act(() => {
    updateTaskState(TASK_ID, { contextFiles: files });
  });
};

const flushRequests = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const getRowCheckbox = (fileName: string): HTMLElement => {
  const row = screen.getByText(fileName).closest('div.h-6');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No row found for ${fileName}`);
  }
  return within(row).getByRole('checkbox');
};

describe('ContextFilesSection checkbox toggles', () => {
  beforeEach(() => {
    vi.mocked(showErrorNotification).mockClear();
  });

  afterEach(() => {
    cleanup();
    useTaskStore.setState({ taskStateMap: new Map() });
  });

  it('shows the new state immediately while the request is pending', async () => {
    const { api, requests } = renderSection(initialFiles());
    expect(getRowCheckbox('a.ts')).toBeChecked();
    expect(screen.getByText('(2/3)')).toBeInTheDocument();

    fireEvent.click(getRowCheckbox('a.ts'));
    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    expect(screen.getByText('(1/3)')).toBeInTheDocument();

    await flushRequests();
    expect(api.setContextFilesDisabled).toHaveBeenCalledWith(BASE_DIR, TASK_ID, ['a.ts'], true);
    expect(getRowCheckbox('a.ts')).not.toBeChecked();

    setStoreFiles([file('a.ts', true), file('b.ts'), file('c.ts', true)]);
    requests[0].resolve();
    await flushRequests();
    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    expect(api.refreshContextFiles).not.toHaveBeenCalled();

    // A later backend change to the file is shown, so nothing is left overriding it.
    setStoreFiles(initialFiles());
    expect(getRowCheckbox('a.ts')).toBeChecked();
  });

  it('restores the stored state and shows an error when the request fails', async () => {
    const { api, requests } = renderSection(initialFiles());

    fireEvent.click(getRowCheckbox('a.ts'));
    expect(getRowCheckbox('a.ts')).not.toBeChecked();

    await flushRequests();
    requests[0].reject(new Error('boom'));
    await flushRequests();

    expect(getRowCheckbox('a.ts')).toBeChecked();
    expect(screen.getByText('(2/3)')).toBeInTheDocument();
    expect(showErrorNotification).toHaveBeenCalledWith('boom');
    expect(api.refreshContextFiles).toHaveBeenCalledWith(BASE_DIR, TASK_ID);
  });

  it('sends requests one at a time and a failed toggle does not undo a later toggle of another file', async () => {
    const { api, requests } = renderSection(initialFiles());

    fireEvent.click(getRowCheckbox('a.ts'));
    fireEvent.click(getRowCheckbox('b.ts'));
    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    expect(getRowCheckbox('b.ts')).not.toBeChecked();
    expect(screen.getByText('(0/3)')).toBeInTheDocument();

    await flushRequests();
    expect(api.setContextFilesDisabled).toHaveBeenCalledTimes(1);
    expect(api.setContextFilesDisabled).toHaveBeenNthCalledWith(1, BASE_DIR, TASK_ID, ['a.ts'], true);

    requests[0].reject(new Error('a failed'));
    await flushRequests();

    expect(api.setContextFilesDisabled).toHaveBeenCalledTimes(2);
    expect(api.setContextFilesDisabled).toHaveBeenNthCalledWith(2, BASE_DIR, TASK_ID, ['b.ts'], true);
    expect(getRowCheckbox('a.ts')).toBeChecked();
    expect(getRowCheckbox('b.ts')).not.toBeChecked();
    expect(showErrorNotification).toHaveBeenCalledWith('a failed');

    setStoreFiles([file('a.ts'), file('b.ts', true), file('c.ts', true)]);
    requests[1].resolve();
    await flushRequests();

    expect(getRowCheckbox('a.ts')).toBeChecked();
    expect(getRowCheckbox('b.ts')).not.toBeChecked();
    expect(screen.getByText('(1/3)')).toBeInTheDocument();
  });

  it('keeps the last click when the same file is toggled repeatedly and older updates arrive', async () => {
    const { api, requests } = renderSection(initialFiles());

    fireEvent.click(getRowCheckbox('a.ts'));
    fireEvent.click(getRowCheckbox('a.ts'));
    fireEvent.click(getRowCheckbox('a.ts'));
    expect(getRowCheckbox('a.ts')).not.toBeChecked();

    await flushRequests();
    expect(api.setContextFilesDisabled).toHaveBeenCalledTimes(1);
    expect(api.setContextFilesDisabled).toHaveBeenNthCalledWith(1, BASE_DIR, TASK_ID, ['a.ts'], true);

    setStoreFiles([file('a.ts', true), file('b.ts'), file('c.ts', true)]);
    requests[0].resolve();
    await flushRequests();
    expect(api.setContextFilesDisabled).toHaveBeenNthCalledWith(2, BASE_DIR, TASK_ID, ['a.ts'], false);
    expect(getRowCheckbox('a.ts')).not.toBeChecked();

    // The update for the second click shows the file enabled, but the third click is still pending.
    setStoreFiles(initialFiles());
    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    requests[1].resolve();
    await flushRequests();
    expect(api.setContextFilesDisabled).toHaveBeenNthCalledWith(3, BASE_DIR, TASK_ID, ['a.ts'], true);
    expect(getRowCheckbox('a.ts')).not.toBeChecked();

    setStoreFiles([file('a.ts', true), file('b.ts'), file('c.ts', true)]);
    requests[2].resolve();
    await flushRequests();
    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    expect(api.setContextFilesDisabled).toHaveBeenCalledTimes(3);

    setStoreFiles(initialFiles());
    expect(getRowCheckbox('a.ts')).toBeChecked();
  });

  it('restores each file of a failed shift-click range to its own previous state', async () => {
    const { api, requests } = renderSection(initialFiles());

    fireEvent.click(getRowCheckbox('a.ts'));
    await flushRequests();
    setStoreFiles([file('a.ts', true), file('b.ts'), file('c.ts', true)]);
    requests[0].resolve();
    await flushRequests();

    // a, b and c are now disabled, enabled and disabled. Shift-clicking c enables the whole range from a.
    fireEvent.click(getRowCheckbox('c.ts'), { shiftKey: true });
    expect(getRowCheckbox('a.ts')).toBeChecked();
    expect(getRowCheckbox('b.ts')).toBeChecked();
    expect(getRowCheckbox('c.ts')).toBeChecked();
    expect(screen.getByText('(3)')).toBeInTheDocument();

    await flushRequests();
    expect(api.setContextFilesDisabled).toHaveBeenNthCalledWith(2, BASE_DIR, TASK_ID, ['a.ts', 'b.ts', 'c.ts'], false);

    requests[1].reject(new Error('range failed'));
    await flushRequests();

    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    expect(getRowCheckbox('b.ts')).toBeChecked();
    expect(getRowCheckbox('c.ts')).not.toBeChecked();
    expect(screen.getByText('(1/3)')).toBeInTheDocument();
    expect(showErrorNotification).toHaveBeenCalledWith('range failed');
  });

  it('keeps the pending state across unrelated context-file updates', async () => {
    const { requests } = renderSection(initialFiles());

    fireEvent.click(getRowCheckbox('a.ts'));
    await flushRequests();

    // c.ts was dropped and d.ts added elsewhere; this update still shows a.ts enabled.
    setStoreFiles([file('a.ts'), file('b.ts'), file('d.ts')]);
    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    expect(screen.queryByText('c.ts')).not.toBeInTheDocument();
    expect(getRowCheckbox('d.ts')).toBeChecked();
    expect(screen.getByText('(2/3)')).toBeInTheDocument();

    setStoreFiles([file('a.ts', true), file('b.ts'), file('d.ts')]);
    requests[0].resolve();
    await flushRequests();
    expect(getRowCheckbox('a.ts')).not.toBeChecked();

    setStoreFiles([file('a.ts'), file('b.ts'), file('d.ts')]);
    expect(getRowCheckbox('a.ts')).toBeChecked();
  });

  it('keeps the new state when the request succeeds before the confirming update arrives', async () => {
    const { api, requests } = renderSection(initialFiles());

    fireEvent.click(getRowCheckbox('a.ts'));
    await flushRequests();
    requests[0].resolve();
    await flushRequests();

    expect(getRowCheckbox('a.ts')).not.toBeChecked();
    expect(api.refreshContextFiles).toHaveBeenCalledWith(BASE_DIR, TASK_ID);

    setStoreFiles([file('a.ts', true), file('b.ts'), file('c.ts', true)]);
    expect(getRowCheckbox('a.ts')).not.toBeChecked();

    setStoreFiles(initialFiles());
    expect(getRowCheckbox('a.ts')).toBeChecked();
  });
});