import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
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

  // Ref to the Milkdown root element so we can locate the ProseMirror canvas
  // for imperative focus operations.
  const rootRef = useRef<HTMLDivElement>(null);

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

  // Expose an imperative getter so the parent can read the authoritative
  // markdown value at any time (e.g. on close, before the debounce fires).
  useImperativeHandle(ref, () => ({
    getMarkdown: () => {
      const editor = getInstance();
      return editor ? editor.action(getMarkdownAction()) : initialValue;
    },
    // Focus the ProseMirror contenteditable canvas. Uses requestAnimationFrame
    // to ensure the canvas has been created by Milkdown before attempting focus.
    focus: () => {
      requestAnimationFrame(() => {
        const canvas = rootRef.current?.querySelector('.ProseMirror') as HTMLElement | null;
        if (canvas) {
          canvas.focus();
        }
      });
    },
  }), [getInstance, initialValue]);

  return <Milkdown ref={rootRef} />;
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
