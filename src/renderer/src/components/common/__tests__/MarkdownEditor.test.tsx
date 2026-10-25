import { type ChangeEvent } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';

import { MarkdownEditor, getMarkdownEditorExtensions } from '../MarkdownEditor';

import { promptLivePreviewExtension } from '@/components/PromptField/promptLivePreview';
import { promptMarkdownExtension } from '@/components/PromptField/promptMarkdown';

vi.mock('@codemirror/language-data', () => ({
  languages: [],
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { settings: null }) => unknown) => selector({ settings: null }),
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange, className, placeholder }: { value: string; onChange: (value: string) => void; className?: string; placeholder?: string }) => (
    <textarea
      aria-label="markdown-editor"
      className={className}
      placeholder={placeholder}
      value={value}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
    />
  ),
}));

describe('getMarkdownEditorExtensions', () => {
  it('includes the live-preview extension only when asked', () => {
    const withPreview = getMarkdownEditorExtensions(true);
    const withoutPreview = getMarkdownEditorExtensions(false);

    expect(withPreview).toContain(promptLivePreviewExtension);
    expect(withoutPreview).not.toContain(promptLivePreviewExtension);
    for (const extensions of [withPreview, withoutPreview]) {
      expect(extensions).toContain(promptMarkdownExtension);
      expect(extensions).toContain(EditorView.lineWrapping);
    }
  });
});

describe('MarkdownEditor', () => {
  it('renders the value', () => {
    render(<MarkdownEditor value="# Title" onChange={vi.fn()} />);

    expect(screen.getByLabelText('markdown-editor')).toHaveValue('# Title');
  });

  it('calls onChange with the new text on input', () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('markdown-editor'), { target: { value: 'New text' } });

    expect(onChange).toHaveBeenCalledWith('New text');
  });

  it('carries the pf-prompt-editor class alongside its own', () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} className="custom-editor" large fontSize={16} />);

    const editor = screen.getByLabelText('markdown-editor');
    expect(editor).toHaveClass('pf-prompt-editor', 'custom-editor', 'pf-prompt-editor-large', 'pf-prompt-editor-font-size');
  });
});
