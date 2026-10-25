import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Workspace } from '../Workspace';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { ApiContext } from '@/contexts/ApiContext';

vi.mock('@/contexts/ProjectSettingsContext', () => ({
  useProjectSettings: () => ({ projectSettings: null, saveProjectSettings: vi.fn() }),
}));

vi.mock('@/hooks/useOS', () => ({
  useOS: () => null,
}));

vi.mock('../ContextFilesPane', () => ({
  ContextFilesPane: ({ isOpen }: { isOpen: boolean }) => <div data-testid="section-context" data-open={String(isOpen)} />,
}));

vi.mock('../UpdatedFilesSection', () => ({
  UpdatedFilesSection: ({ isOpen }: { isOpen: boolean }) => <div data-testid="section-updated" data-open={String(isOpen)} />,
}));

vi.mock('../ProjectFilesSection', () => ({
  ProjectFilesSection: ({ isOpen }: { isOpen: boolean }) => <div data-testid="section-project" data-open={String(isOpen)} />,
}));

vi.mock('../SkillsSection', () => ({
  SkillsSection: ({ isOpen }: { isOpen: boolean }) => <div data-testid="section-skills" data-open={String(isOpen)} />,
}));

const BASE_DIR = '/project';

const renderWorkspace = () =>
  render(
    <ApiContext.Provider value={createMockApi()}>
      <Workspace
        baseDir={BASE_DIR}
        taskId="task-1"
        taskDir={BASE_DIR}
        allFiles={[]}
        contextFiles={[]}
        showFileDialog={() => undefined}
        refreshAllFiles={() => Promise.resolve()}
        refreshContextFiles={() => Promise.resolve()}
        mode="agent"
      />
    </ApiContext.Provider>,
  );

describe('Workspace active section', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('opens Context Files when the stored section no longer exists', () => {
    localStorage.setItem(`workspace-active-section-${BASE_DIR}`, 'outline');

    renderWorkspace();

    expect(screen.getByTestId('section-context')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('section-updated')).toHaveAttribute('data-open', 'false');
  });

  it('keeps a stored section that still exists', () => {
    localStorage.setItem(`workspace-active-section-${BASE_DIR}`, 'updated');

    renderWorkspace();

    expect(screen.getByTestId('section-updated')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('section-context')).toHaveAttribute('data-open', 'false');
  });
});
