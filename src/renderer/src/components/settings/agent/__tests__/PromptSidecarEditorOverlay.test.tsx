import { type ChangeEvent } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptSidecarEditorOverlay } from '../PromptSidecarEditorOverlay';

import { useApi } from '@/contexts/ApiContext';

vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: vi.fn(),
  useHotkeysContext: () => ({ enableScope: vi.fn(), disableScope: vi.fn() }),
}));

vi.mock('@codemirror/language-data', () => ({
  languages: [],
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { settings: null }) => unknown) => selector({ settings: null }),
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="markdown-editor" value={value} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)} />
  ),
}));

vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(),
}));

vi.mock('@/utils/notifications', () => ({
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

describe('PromptSidecarEditorOverlay', () => {
  const getAgentPromptSidecar = vi.fn();
  const saveAgentPromptSidecar = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getAgentPromptSidecar.mockResolvedValue('# Original prompt');
    saveAgentPromptSidecar.mockResolvedValue(undefined);
    vi.mocked(useApi).mockReturnValue({
      getAgentPromptSidecar,
      saveAgentPromptSidecar,
    } as unknown as ReturnType<typeof useApi>);
  });

  const renderOverlay = () => {
    render(<PromptSidecarEditorOverlay profileId="profile-1" profileName="Profile One" filename="systemPrompt.md" title="System Prompt" onClose={onClose} />);
    return screen.findByLabelText('markdown-editor');
  };

  const getSaveButton = () => screen.getByText('common.save').closest('button') as HTMLButtonElement;

  it('shows the loaded content', async () => {
    const editor = await renderOverlay();

    expect(getAgentPromptSidecar).toHaveBeenCalledWith('profile-1', 'systemPrompt.md');
    expect(editor).toHaveValue('# Original prompt');
  });

  it('marks the content dirty and enables Save when edited', async () => {
    const editor = await renderOverlay();
    expect(getSaveButton()).toBeDisabled();

    fireEvent.change(editor, { target: { value: '# Edited prompt' } });

    expect(getSaveButton()).toBeEnabled();
  });

  it('saves the new text and then closes', async () => {
    const editor = await renderOverlay();
    fireEvent.change(editor, { target: { value: '# Edited prompt' } });

    fireEvent.click(getSaveButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(saveAgentPromptSidecar).toHaveBeenCalledWith('profile-1', 'systemPrompt.md', '# Edited prompt');
    expect(saveAgentPromptSidecar.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });

  it('asks for confirmation instead of closing on Escape when dirty', async () => {
    const editor = await renderOverlay();
    fireEvent.change(editor, { target: { value: '# Edited prompt' } });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(await screen.findByText('settings.agent.promptSidecar.discardTitle')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape when clean', async () => {
    await renderOverlay();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
