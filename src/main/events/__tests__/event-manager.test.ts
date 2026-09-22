import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import { MessageRemovedData } from '@common/types';

import { EventManager } from '../event-manager';

import type { WindowManager } from '@/window-manager';

vi.mock('@/logger');

describe('EventManager - sendTaskMessageRemoved', () => {
  let eventManager: EventManager;
  let mockMainWindow: Partial<BrowserWindow>;
  let mockWindowManager: WindowManager;
  let mockWebContents: {
    send: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    isCrashed: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockWebContents = {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isCrashed: vi.fn(() => false),
    };

    mockMainWindow = {
      webContents: mockWebContents as any,
      isDestroyed: vi.fn(() => false),
    };

    // Create a mock WindowManager
    mockWindowManager = {
      getAllWindows: vi.fn(() => [mockMainWindow as BrowserWindow]),
      getMainWindow: vi.fn(() => mockMainWindow as BrowserWindow),
      addWindow: vi.fn(),
      removeWindow: vi.fn(),
      isMainWindow: vi.fn(() => true),
      getWindowCount: vi.fn(() => 1),
    } as any;

    eventManager = new EventManager(mockWindowManager);
  });

  it('should send message-removed event to main window', () => {
    const baseDir = '/test/project';
    const taskId = 'task-123';
    const messageIds = ['msg-456'];

    eventManager.sendTaskMessageRemoved(baseDir, taskId, messageIds);

    expect(mockWebContents.send).toHaveBeenCalledWith('message-removed', {
      baseDir,
      taskId,
      messageIds,
    } as MessageRemovedData);
  });

  it('should not send to destroyed window', () => {
    mockMainWindow.isDestroyed = vi.fn(() => true);

    eventManager.sendTaskMessageRemoved('/test/project', 'task-123', ['msg-456']);

    expect(mockWebContents.send).not.toHaveBeenCalled();
  });

  it('should handle no windows', () => {
    const emptyWindowManager = {
      getAllWindows: vi.fn(() => []),
      getMainWindow: vi.fn(() => null),
      addWindow: vi.fn(),
      removeWindow: vi.fn(),
      isMainWindow: vi.fn(() => false),
      getWindowCount: vi.fn(() => 0),
    } as any;

    const noWindowEventManager = new EventManager(emptyWindowManager);

    noWindowEventManager.sendTaskMessageRemoved('/test/project', 'task-123', ['msg-456']);

    // Should not throw
    expect(true).toBe(true);
  });
});

describe('EventManager - coalesced streaming mode', () => {
  let eventManager: EventManager;
  let mockSocket: {
    id: string;
    emit: ReturnType<typeof vi.fn>;
  };
  let mockMainWindow: Partial<BrowserWindow>;
  let mockWindowManager: WindowManager;
  let mockWebContents: {
    send: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();

    mockWebContents = {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
    };

    mockMainWindow = {
      webContents: mockWebContents as any,
      isDestroyed: vi.fn(() => false),
    };

    mockWindowManager = {
      getAllWindows: vi.fn(() => [mockMainWindow as BrowserWindow]),
      getMainWindow: vi.fn(() => mockMainWindow as BrowserWindow),
      addWindow: vi.fn(),
      removeWindow: vi.fn(),
      isMainWindow: vi.fn(() => true),
      getWindowCount: vi.fn(() => 1),
    } as any;

    mockSocket = {
      id: 'socket-coalesced-1',
      emit: vi.fn(),
    };

    eventManager = new EventManager(mockWindowManager);

    // Subscribe with coalesced streaming mode and a fast flush interval
    eventManager.subscribe(mockSocket as any, {
      streamMode: 'coalesced',
      streamFlushIntervalMs: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should buffer consecutive response-chunk calls and flush concatenated content', () => {
    const baseDir = '/test/project';
    const taskId = 'task-coalesced-1';
    const messageId = 'msg-coalesced-1';

    // Send three response chunks for the same task/message
    eventManager.sendResponseChunk({
      baseDir,
      taskId,
      messageId,
      chunk: 'Hello ',
      reflectedMessage: false,
    });

    eventManager.sendResponseChunk({
      baseDir,
      taskId,
      messageId,
      chunk: 'World',
      reflectedMessage: false,
    });

    eventManager.sendResponseChunk({
      baseDir,
      taskId,
      messageId,
      chunk: '!',
      reflectedMessage: false,
    });

    // No event should have been emitted yet (buffered)
    expect(mockSocket.emit).not.toHaveBeenCalled();

    // Advance the flush timer and let the timeout fire
    vi.advanceTimersByTime(200);

    // Now the socket should have received one event with concatenated content
    expect(mockSocket.emit).toHaveBeenCalledTimes(1);
    expect(mockSocket.emit).toHaveBeenCalledWith('event', {
      type: 'response-chunk',
      data: expect.objectContaining({
        baseDir,
        taskId,
        messageId,
        chunk: 'Hello World!',
      }),
    });
  });

  it('should emit sendTaskUpdated immediately in coalesced mode', () => {
    const taskData = {
      id: 'task-immediate-1',
      baseDir: '/test/project',
      title: 'Test Task',
      status: 'running' as const,
    };

    eventManager.sendTaskUpdated(taskData as any);

    // task-updated is not in COALESCE_STRATEGIES, so it should emit immediately
    // but first it flushes pending entries for the same task (none in this case)
    expect(mockSocket.emit).toHaveBeenCalledWith('event', {
      type: 'task-updated',
      data: taskData,
    });
  });

  it('should preserve existing sendTaskMessageRemoved coverage in coalesced mode', () => {
    const baseDir = '/test/project';
    const taskId = 'task-coalesced-coverage';
    const messageIds = ['msg-789'];

    eventManager.sendTaskMessageRemoved(baseDir, taskId, messageIds);

    // message-removed is not in COALESCE_STRATEGIES, so it emits immediately
    expect(mockSocket.emit).toHaveBeenCalledWith('event', {
      type: 'message-removed',
      data: { baseDir, taskId, messageIds },
    });
  });
});
