import { vi } from 'vitest';
import { ContextFile, TaskData } from '@common/types';

import { Task } from '@/task';

/**
 * Creates a minimal mock for Task class
 * Provides only the properties/methods needed for testing
 */
export const createMockTask = (overrides: Partial<TaskData> = {}) => {
  const defaultMock = {
    getProjectDir: vi.fn((): string => '/test/project'),
    getTaskDir: vi.fn((): string => '/test/project'),
    getContextSnapshotDir: vi.fn((): string => '/test/project/.aider-desk/tasks/task-1'),
    task: { autonomyMode: 'guided' } as TaskData,
    getRuleFilesAsContextFiles: vi.fn((): Promise<ContextFile[]> => Promise.resolve([])),
    project: {
      baseDir: '/test/project',
    },
    getProject: vi.fn(() => ({
      baseDir: '/test/project',
    })),
    getRepositoryMappingFiles: vi.fn((): Promise<ContextFile[]> => Promise.resolve([])),
    getRepositoryMappingFilesForPrompt: vi.fn(() => Promise.resolve({ files: [], overBudget: [] })),
    resolveContextFilePath: vi.fn((): Promise<string | null> => Promise.resolve(null)),
    getTaskAgentProfileId: vi.fn((): string | undefined => undefined),
  };

  return { ...defaultMock, ...overrides } as unknown as Task;
};
