import { forwardRef, useImperativeHandle, useMemo, useRef, type CSSProperties } from 'react';
import { EditorView } from '@codemirror/view';
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { clsx } from 'clsx';

import { promptLivePreviewExtension } from '@/components/PromptField/promptLivePreview';
import { promptEditorTheme, promptMarkdownExtension } from '@/components/PromptField/promptMarkdown';
import { useSettingsStore } from '@/stores/settingsStore';

const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  syntaxHighlighting: false,
  searchKeymap: false,
  autocompletion: false,
};

/** Markdown highlighting, the optional live preview and line wrapping, shared by every markdown editor. */
export const getMarkdownEditorExtensions = (livePreview: boolean): Extension[] => [
  promptMarkdownExtension,
  ...(livePreview ? [promptLivePreviewExtension] : []),
  EditorView.lineWrapping,
];

export type MarkdownEditorRef = {
  focus: () => void;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** Added after the shared markdown extensions. */
  extensions?: Extension[];
  /** Defaults to the prompt behaviour's live-preview setting. */
  livePreview?: boolean;
  /** Shows headings larger. */
  large?: boolean;
  /** Font size of the text, in pixels. */
  fontSize?: number;
};

/** A CodeMirror markdown editor with the app's markdown highlighting and Obsidian-style live preview. */
export const MarkdownEditor = forwardRef<MarkdownEditorRef, Props>(
  ({ value, onChange, placeholder, autoFocus, className, extensions, livePreview, large = false, fontSize }, ref) => {
    const livePreviewSetting = useSettingsStore((state) => state.settings?.promptBehavior?.livePreview ?? true);
    const livePreviewEnabled = livePreview ?? livePreviewSetting;
    const editorRef = useRef<ReactCodeMirrorRef>(null);

    useImperativeHandle(ref, () => ({
      focus: () => {
        editorRef.current?.view?.focus();
      },
    }));

    const allExtensions = useMemo(() => [...getMarkdownEditorExtensions(livePreviewEnabled), ...(extensions ?? [])], [livePreviewEnabled, extensions]);

    return (
      <CodeMirror
        ref={editorRef}
        value={value}
        onChange={(newValue) => onChange(newValue)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        className={clsx('pf-prompt-editor', large && 'pf-prompt-editor-large', fontSize !== undefined && 'pf-prompt-editor-font-size', className)}
        style={fontSize !== undefined ? ({ '--prompt-editor-font-size': `${fontSize}px` } as CSSProperties) : undefined}
        theme={promptEditorTheme}
        basicSetup={BASIC_SETUP}
        extensions={allExtensions}
      />
    );
  },
);

MarkdownEditor.displayName = 'MarkdownEditor';
