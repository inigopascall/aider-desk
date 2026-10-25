import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSettings } from '@common/types';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { ApiContext } from '@/contexts/ApiContext';
import { ProjectSettingsProvider, useProjectSettings } from '@/contexts/ProjectSettingsContext';

const Consumer = ({ onSaveError }: { onSaveError?: (error: unknown) => void }) => {
  const { projectSettings, saveProjectSettings } = useProjectSettings();

  return (
    <>
      <span data-testid="loaded">{projectSettings === null ? 'false' : 'true'}</span>
      <span data-testid="rules">{projectSettings ? (projectSettings.contextSidebarSectionsHidden ?? []).join(',') : 'none'}</span>
      <button
        onClick={() => {
          void saveProjectSettings({ contextSidebarSectionsHidden: ['a'] }).catch(onSaveError ?? (() => undefined));
        }}
      >
        save
      </button>
    </>
  );
};

describe('ProjectSettingsProvider', () => {
  it('keeps optimistic value while patch is pending and reconciles on success', async () => {
    const initialSettings = { contextSidebarSectionsHidden: [] } as unknown as ProjectSettings;
    const savedSettings = { contextSidebarSectionsHidden: ['a'] } as unknown as ProjectSettings;
    let resolvePatch: (settings: ProjectSettings) => void = () => undefined;
    const patchPromise = new Promise<ProjectSettings>((resolve) => {
      resolvePatch = resolve;
    });
    const mockApi = createMockApi({
      getProjectSettings: vi.fn().mockResolvedValue(initialSettings),
      patchProjectSettings: vi.fn().mockReturnValue(patchPromise),
    });

    render(
      <ApiContext.Provider value={mockApi}>
        <ProjectSettingsProvider baseDir="/project">
          <Consumer />
        </ProjectSettingsProvider>
      </ApiContext.Provider>,
    );

    // Wait until settings are demonstrably loaded (distinct from the null state).
    await waitFor(() => expect(screen.getByTestId('loaded')).toHaveTextContent('true'));
    expect(screen.getByTestId('rules')).toHaveTextContent('');

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    // Optimistic value is displayed while the patch is pending.
    await waitFor(() => expect(screen.getByTestId('rules')).toHaveTextContent('a'));
    expect(screen.getByTestId('rules')).toHaveTextContent('a');

    // An unrelated settings event while the patch is pending must not bounce
    // the optimistic value back to the base value.
    const listener = vi.mocked(mockApi.addProjectSettingsUpdatedListener).mock.calls[0][1];
    act(() => {
      listener({ baseDir: '/project', settings: { ...initialSettings, contextSidebarSectionsHidden: [] } });
    });
    expect(screen.getByTestId('rules')).toHaveTextContent('a');

    await act(async () => {
      resolvePatch(savedSettings);
      await patchPromise;
    });

    // After the patch resolves, the base state reconciles to the saved value.
    expect(screen.getByTestId('rules')).toHaveTextContent('a');
  });

  it('reverts to the base value when the save is rejected', async () => {
    const initialSettings = { contextSidebarSectionsHidden: [] } as unknown as ProjectSettings;
    let rejectPatch: (error: Error) => void = () => undefined;
    const patchPromise = new Promise<ProjectSettings>((_, reject) => {
      rejectPatch = reject;
    });
    const saveError = new Error('save failed');
    const onSaveError = vi.fn();
    const mockApi = createMockApi({
      getProjectSettings: vi.fn().mockResolvedValue(initialSettings),
      patchProjectSettings: vi.fn().mockReturnValue(patchPromise),
    });

    render(
      <ApiContext.Provider value={mockApi}>
        <ProjectSettingsProvider baseDir="/project">
          <Consumer onSaveError={onSaveError} />
        </ProjectSettingsProvider>
      </ApiContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId('loaded')).toHaveTextContent('true'));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(screen.getByTestId('rules')).toHaveTextContent('a'));

    await act(async () => {
      rejectPatch(saveError);
      await patchPromise.catch(() => undefined);
    });

    // The optimistic value is reverted to the base value and the rejection is
    // surfaced to the consumer (no unhandled rejection).
    expect(screen.getByTestId('rules')).toHaveTextContent('');
    expect(onSaveError).toHaveBeenCalledWith(saveError);
  });
});