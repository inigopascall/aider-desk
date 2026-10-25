import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { type EditorState, type Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Markdown syntax highlighting for the prompt editor.
 *
 * Tokens get `pf-md-*` CSS classes rather than inline colours, so their colours come
 * from the app theme's CSS variables. The rules are in `main.css`, scoped to
 * `.pf-prompt-editor`.
 */
export const promptMarkdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: 'pf-md-heading pf-md-h1' },
  { tag: tags.heading2, class: 'pf-md-heading pf-md-h2' },
  { tag: tags.heading3, class: 'pf-md-heading pf-md-h3' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: 'pf-md-heading pf-md-h4' },
  { tag: tags.heading, class: 'pf-md-heading' },
  { tag: tags.strong, class: 'pf-md-strong' },
  { tag: tags.emphasis, class: 'pf-md-emphasis' },
  { tag: tags.strikethrough, class: 'pf-md-strikethrough' },
  { tag: tags.monospace, class: 'pf-md-code' },
  { tag: [tags.link, tags.url], class: 'pf-md-link' },
  { tag: tags.labelName, class: 'pf-md-meta' },
  { tag: tags.quote, class: 'pf-md-quote' },
  { tag: [tags.processingInstruction, tags.contentSeparator], class: 'pf-md-mark' },
  { tag: tags.comment, class: 'pf-md-comment' },
  // Tokens inside fenced code blocks, highlighted in the block's own language.
  { tag: tags.keyword, class: 'pf-md-tok-keyword' },
  { tag: [tags.string, tags.regexp], class: 'pf-md-tok-string' },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], class: 'pf-md-tok-literal' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'pf-md-tok-function' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'pf-md-tok-type' },
  { tag: [tags.propertyName, tags.attributeName], class: 'pf-md-tok-property' },
  { tag: tags.tagName, class: 'pf-md-tok-tag' },
]);

const codeBlockLineDecoration = Decoration.line({ class: 'pf-md-codeblock-line' });

/** Start positions of every line between `from` and `to` that belongs to a fenced code block. */
export const findFencedCodeLineStarts = (state: EditorState, from = 0, to = state.doc.length): number[] => {
  const starts: number[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== 'FencedCode') {
        return true;
      }
      const firstLine = state.doc.lineAt(Math.max(node.from, from)).number;
      const lastLine = state.doc.lineAt(Math.min(node.to, to)).number;
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
        starts.push(state.doc.line(lineNumber).from);
      }
      return false;
    },
  });
  return starts;
};

const buildCodeBlockDecorations = (view: EditorView): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  let lastStart = -1;
  for (const { from, to } of view.visibleRanges) {
    for (const start of findFencedCodeLineStarts(view.state, from, to)) {
      if (start > lastStart) {
        builder.add(start, start, codeBlockLineDecoration);
        lastStart = start;
      }
    }
  }
  return builder.finish();
};

const codeBlockLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCodeBlockDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = buildCodeBlockDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Markdown language, highlighting and code-block line backgrounds for the prompt editor. */
export const promptMarkdownExtension: Extension = [
  markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false, completeHTMLTags: false }),
  syntaxHighlighting(promptMarkdownHighlightStyle),
  codeBlockLines,
];

/**
 * Base appearance of the prompt editor, in the app theme's colours. It adds no syntax
 * highlighting of its own, so `promptMarkdownHighlightStyle` alone colours the markdown.
 */
export const promptEditorTheme: Extension = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--color-text-primary)',
    },
    '&.cm-editor .cm-scroller': {
      fontFamily: 'var(--font-family)',
    },
    '.cm-content': {
      caretColor: 'var(--color-text-muted)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-text-muted)',
    },
    '&.cm-focused .cm-selectionBackground, & .cm-line::selection, & .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
      background: 'var(--color-bg-selection) !important',
    },
  },
  { dark: true },
);
