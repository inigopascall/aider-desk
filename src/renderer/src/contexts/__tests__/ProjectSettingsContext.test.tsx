import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSettings } from '@common/types';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { ApiContext } from '@/contexts/ApiContext';
import { ProjectSettingsProvider, useProjectSettings } from '@/contexts/ProjectSettingsContext';

const Consumer = () => {
  const { projectSettings, saveProjectSettings } = useProjectSettings();

  return (
    <>
      <span data-testid="rules">{projectSettings ? projectSettings.disabledRuleFiles.join(',') : 'none'}</span>
      <button onClick={() => void saveProjectSettings({ disabledRuleFiles: ['a'] })}>save</button>
    </>
  );
};

describe('ProjectSettingsProvider', () => {
  it('keeps optimistic value while patch is pending', async () => {
    const initialSettings = { disabledRuleFiles: [] } as unknown as ProjectSettings;
    const savedSettings = { disabledRuleFiles: ['a'] } as unknown as ProjectSettings;
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

    await waitFor(() => expect(screen.getByTestId('rules')).toHaveTextContent(''));

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(screen.getByTestId('rules')).toHaveTextContent('a'));
    expect(screen.getByTestId('rules')).toHaveTextContent('a');

    await act(async () => {
      resolvePatch(savedSettings);
      await patchPromise;
    });

    expect(screen.getByTestId('rules')).toHaveTextContent('a');
  });
});
