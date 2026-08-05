import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx, editorViewCtx } from '@milkdown/kit/core';
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
};

/**
 * Inner editor component. Must be rendered inside a MilkdownProvider.
 * Receives an initial markdown string, seeds the editor, and calls
 * onChange whenever the markdown content is updated (debounced by Milkdown).
 */
const MilkdownInner = forwardRef<MilkdownEditorRef, Props>(({ initialValue, onChange }, ref) => {
  // Keep a stable ref to the latest onChange so the listener never goes stale
  // and we don't need to recreate the editor on every callback change.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const [, getInstance] = useInstance();

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
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener),
  );

  // Stable ref for the deferred focus callback so cleanup can cancel it.
  const pendingFocusRef = useRef<(() => void) | null>(null);

  // Focus the actual ProseMirror editor view (not just the contenteditable div)
  // and place the selection at the end of the document. Milkdown creates the
  // editor view asynchronously, so we defer with requestAnimationFrame and
  // retry only once per mount.
  useImperativeHandle(ref, () => ({
    getMarkdown: () => {
      const editor = getInstance();
      return editor ? editor.action(getMarkdownAction()) : initialValue;
    },
    focus: () => {
      // Cancel any previous pending focus request so stale callbacks don't run
      // after the editor has been remounted or unmounted.
      pendingFocusRef.current = null;

      const doFocus = () => {
        const editor = getInstance();
        if (!editor) return;
        const view = editor.get(editorViewCtx);
        if (!view || view.isDestroyed) return;
        view.focus();
        const end = view.state.doc.length;
        view.dispatch({ selection: { anchor: end, head: end } });
      };

      // First attempt: wait for the next paint so Milkdown has created the view.
      const raf = requestAnimationFrame(() => {
        const editor = getInstance();
        const view = editor ? editor.get(editorViewCtx) : null;
        if (view && !view.isDestroyed) {
          doFocus();
        } else {
          // View not yet ready; schedule one retry after another paint cycle.
          pendingFocusRef.current = () => {
            const editor = getInstance();
            const view = editor ? editor.get(editorViewCtx) : null;
            if (view && !view.isDestroyed) {
              doFocus();
            }
            pendingFocusRef.current = null;
          };
          requestAnimationFrame(pendingFocusRef.current);
        }
      });

      // Cleanup: cancel the deferred retry if the editor unmounts before it runs.
      return () => {
        cancelAnimationFrame(raf);
        pendingFocusRef.current = null;
      };
    },
  }), [getInstance, initialValue]);

  return <Milkdown />;
});

MilkdownInner.displayName = 'MilkdownInner';

/**
 * Public MilkdownEditor component wrapped in a MilkdownProvider.
 */
export const MilkdownEditor = forwardRef<MilkdownEditorRef, Props>((props, ref) => (
  <MilkdownProvider>
    <MilkdownInner {...props} ref={ref} />
  </MilkdownProvider>
));
MilkdownEditor.displayName = 'MilkdownEditor';
