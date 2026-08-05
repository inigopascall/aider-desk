import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx, editorViewCtx, editorViewOptionsCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { getMarkdown as getMarkdownAction } from '@milkdown/kit/utils';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';

/**
 * Imperative handle for reading the current markdown value on demand
 * (e.g. before the debounced listener fires) and for focusing the canvas.
 */
export interface MilkdownEditorRef {
  getMarkdown: () => string;
  focus: () => void;
}

type Props = {
  initialValue: string;
  onChange: (markdown: string) => void;
  onReady?: () => void;
};

/**
 * Inner editor component. Must be rendered inside a MilkdownProvider.
 * Receives an initial markdown string, seeds the editor, and calls
 * onChange whenever the markdown content is updated (debounced by Milkdown).
 */
const MilkdownInner = forwardRef<MilkdownEditorRef, Props>(({ initialValue, onChange, onReady }, ref) => {
  // Keep a stable ref to the latest onChange so the listener never goes stale
  // and we don't need to recreate the editor on every callback change.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Keep a stable ref to the latest onReady callback so we can invoke it
  // exactly once when the editor instance becomes available.
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const [loading, getInstance] = useInstance();

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        // Seed the editor with the current prompt text on first mount.
        ctx.set(defaultValueCtx, initialValue);
        ctx.set(remarkStringifyOptionsCtx, {
          bullet: '-',
          listItemIndent: 'one',
          rule: '-',
        });
        // Disable browser diagnostic features at the editor boundary.
        // These attributes prevent spellcheck, autocorrect, autocapitalize,
        // and grammar-checking tools (e.g. Grammarly) from attaching to the
        // editable DOM, which would otherwise create stale diagnostic overlays.
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: {
            ...prev?.attributes,
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off',
            'data-gramm': 'false',
            'data-gramm_editor': 'false',
            'data-enable-grammarly': 'false',
          },
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener),
  );

  // Track whether we've already invoked onReady for this editor instance.
  const onReadyCalledRef = useRef(false);

  // Invoke onReady exactly once when the editor instance and view are available.
  useEffect(() => {
    if (loading || onReadyCalledRef.current) return;
    const editor = getInstance();
    if (!editor) return;
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    if (!view || view.isDestroyed) return;
    onReadyCalledRef.current = true;
    onReadyRef.current?.();
  }, [loading, getInstance, onReady]);

  // Focus the actual ProseMirror editor view and place the selection at the
  // end of the document. This is called only after Milkdown has fully
  // initialized the editor view, so no retry mechanism is needed.
  useImperativeHandle(ref, () => ({
    getMarkdown: () => {
      const editor = getInstance();
      return editor ? editor.action(getMarkdownAction()) : initialValue;
    },
    focus: () => {
      const editor = getInstance();
      if (!editor) return;
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      if (!view || view.isDestroyed) return;
      // Calculate the final position in the document.
      const endPosition = view.state.doc.content.size;
      // Create a selection at the end of the document and dispatch it.
      // ProseMirror accepts a plain { anchor, head } object for the selection field.
      view.dispatch({
        selection: { anchor: endPosition, head: endPosition },
        scrollIntoView: true,
      });
      // Focus the EditorView so the cursor becomes active.
      view.focus();
      // Fallback: if view.focus() didn't result in the element being focused
      // (can happen with some browser/prosemirror configurations), focus the
      // DOM node directly.
      if (view.dom && document.activeElement !== view.dom) {
        view.dom.focus();
      }
    },
  }), [getInstance, initialValue]);

  return <Milkdown />;
});

MilkdownInner.displayName = 'MilkdownInner';

/**
 * Public MilkdownEditor component wrapped in a MilkdownProvider.
 */
export const MilkdownEditor = forwardRef<MilkdownEditorRef, Props>(({ onReady, ...props }, ref) => (
  <MilkdownProvider>
    <MilkdownInner {...props} ref={ref} onReady={onReady} />
  </MilkdownProvider>
));
MilkdownEditor.displayName = 'MilkdownEditor';
