import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { promptMarkdownExtension } from '../promptMarkdown';
import {
  computeLivePreview,
  FENCE_LINE_CLASS,
  getRevealedLines,
  type LivePreviewSpec,
  promptLivePreviewExtension,
  QUOTE_LINE_CLASS,
  toggleTaskMarker,
} from '../promptLivePreview';

const createState = (doc: string, selection?: EditorSelection) => EditorState.create({ doc, selection, extensions: [promptMarkdownExtension] });

/** Specs for `doc` with no line revealed, as in an unfocused editor. */
const renderAll = (doc: string) => {
  const state = createState(doc);
  return { state, specs: computeLivePreview(state, new Set()) };
};

/** The document text under every spec of one kind, in document order. */
const textOf = (state: EditorState, specs: LivePreviewSpec[], kind: LivePreviewSpec['kind']) =>
  specs
    .filter((spec) => spec.kind === kind)
    .sort((a, b) => a.from - b.from)
    .map((spec) => state.doc.sliceString(spec.from, spec.to));

const hiddenText = (doc: string) => {
  const { state, specs } = renderAll(doc);
  return textOf(state, specs, 'hide');
};

/** Line numbers that have at least one hidden range. */
const linesWithHiddenText = (state: EditorState, specs: LivePreviewSpec[]) =>
  [...new Set(specs.filter((spec) => spec.kind === 'hide').map((spec) => state.doc.lineAt(spec.from).number))].sort((a, b) => a - b);

describe('promptLivePreview', () => {
  describe('on a line that is not revealed', () => {
    it('hides the ATX heading mark and the space after it, and leaves setext headings raw', () => {
      expect(hiddenText('# Title')).toEqual(['# ']);
      expect(hiddenText('### Deeper')).toEqual(['### ']);
      expect(hiddenText('Title\n=====')).toEqual([]);
    });

    it('hides emphasis, strong emphasis and strikethrough marks', () => {
      expect(hiddenText('a *em* **strong** ~~gone~~ b')).toEqual(['*', '*', '**', '**', '~~', '~~']);
    });

    it('hides inline code backticks', () => {
      expect(hiddenText('run `npm test` now')).toEqual(['`', '`']);
    });

    it('shows only the text of an inline link', () => {
      expect(hiddenText('see [the docs](https://example.com "Title") now')).toEqual(['[', '](https://example.com "Title")']);
    });

    it('leaves images, autolinks and reference links raw', () => {
      expect(hiddenText('![alt](image.png)')).toEqual([]);
      expect(hiddenText('<https://example.com>')).toEqual([]);
      expect(hiddenText('[text][ref]\n\n[ref]: https://example.com')).toEqual([]);
    });

    it('replaces bullet marks with a bullet and leaves ordered list numbers', () => {
      const { state, specs } = renderAll('- one\n* two\n+ three\n\n1. four');
      expect(textOf(state, specs, 'bullet')).toEqual(['-', '*', '+']);
      expect(textOf(state, specs, 'hide')).toEqual([]);
    });

    it('replaces task markers with checkboxes', () => {
      const { state, specs } = renderAll('- [ ] todo\n- [x] done');
      const tasks = specs.filter((spec) => spec.kind === 'task');
      expect(tasks.map((spec) => state.doc.sliceString(spec.from, spec.to))).toEqual(['[ ]', '[x]']);
      expect(tasks.map((spec) => spec.kind === 'task' && spec.checked)).toEqual([false, true]);
    });

    it('hides the blockquote mark and marks the line for a left border', () => {
      const { state, specs } = renderAll('> quoted\n\nafter');
      expect(textOf(state, specs, 'hide')).toEqual(['> ']);
      expect(specs.filter((spec) => spec.kind === 'line')).toEqual([{ kind: 'line', from: 0, to: 0, className: QUOTE_LINE_CLASS }]);
    });

    it('replaces a horizontal rule with a rule widget', () => {
      const { state, specs } = renderAll('above\n\n---\n\nbelow');
      expect(textOf(state, specs, 'rule')).toEqual(['---']);
    });

    it('mutes the fence lines of a fenced code block and hides nothing inside it', () => {
      const doc = '```ts\nconst a = `x` * 2 *y* **z**;\n```';
      const { state, specs } = renderAll(doc);
      expect(specs.filter((spec) => spec.kind !== 'line')).toEqual([]);
      expect(specs.filter((spec) => spec.kind === 'line')).toEqual([
        { kind: 'line', from: state.doc.line(1).from, to: state.doc.line(1).from, className: FENCE_LINE_CLASS },
        { kind: 'line', from: state.doc.line(3).from, to: state.doc.line(3).from, className: FENCE_LINE_CLASS },
      ]);
    });

    it('does not mute the fences while a selection touches the block', () => {
      const doc = 'intro\n```\ncode\n```';
      const state = createState(doc, EditorSelection.single(doc.indexOf('code')));
      const specs = computeLivePreview(state, getRevealedLines(state, true));
      expect(specs.filter((spec) => spec.kind === 'line')).toEqual([]);
    });

    it('leaves HTML, tables and escapes untouched', () => {
      expect(renderAll('<b>bold</b> \\*not emphasis\\*\n\n| a | b |\n| --- | --- |\n| *c* | `d` |').specs).toEqual([]);
    });
  });

  describe('revealing lines', () => {
    it('reveals the line the cursor is on', () => {
      const doc = '**one**\n**two**\n**three**';
      const state = createState(doc, EditorSelection.single(doc.indexOf('two')));
      expect([...getRevealedLines(state, true)]).toEqual([2]);
      expect(linesWithHiddenText(state, computeLivePreview(state, getRevealedLines(state, true)))).toEqual([1, 3]);
    });

    it('reveals every line a multi-line selection touches', () => {
      const doc = '*a*\n*b*\n*c*\n*d*';
      const state = createState(doc, EditorSelection.single(doc.indexOf('b'), doc.indexOf('c')));
      expect([...getRevealedLines(state, true)].sort()).toEqual([2, 3]);
      expect(linesWithHiddenText(state, computeLivePreview(state, getRevealedLines(state, true)))).toEqual([1, 4]);
    });

    it('reveals every line touched by any of several selection ranges', () => {
      const doc = '*a*\n*b*\n*c*';
      const state = EditorState.create({
        doc,
        selection: EditorSelection.create([EditorSelection.cursor(doc.indexOf('a')), EditorSelection.cursor(doc.indexOf('c'))]),
        extensions: [promptMarkdownExtension, EditorState.allowMultipleSelections.of(true)],
      });
      expect(linesWithHiddenText(state, computeLivePreview(state, getRevealedLines(state, true)))).toEqual([2]);
    });

    it('renders every line while the editor is unfocused', () => {
      const doc = '# Title\n**bold**';
      const state = createState(doc, EditorSelection.single(doc.indexOf('bold')));
      expect(getRevealedLines(state, false).size).toBe(0);
      expect(linesWithHiddenText(state, computeLivePreview(state, getRevealedLines(state, false)))).toEqual([1, 2]);
    });

    it('only looks at the requested ranges', () => {
      const state = createState('**one**\n**two**');
      const line = state.doc.line(2);
      expect(linesWithHiddenText(state, computeLivePreview(state, new Set(), [{ from: line.from, to: line.to }]))).toEqual([2]);
    });
  });

  it('never hides or replaces a range that crosses a line break', () => {
    const doc = '[link that\nwraps](https://example.com) and *emphasis\nthat wraps* and `code\nspan`\n> quote\n> - [ ] task\n\n***\n\n## Heading ##';
    const { state, specs } = renderAll(doc);
    const replaced = specs.filter((spec) => spec.kind !== 'line');
    expect(replaced.length).toBeGreaterThan(0);
    for (const spec of replaced) {
      expect(state.doc.sliceString(spec.from, spec.to)).not.toContain('\n');
    }
  });

  describe('toggleTaskMarker', () => {
    it('turns [ ] into [x] and back', () => {
      const state = createState('- [ ] todo');
      const pos = state.doc.toString().indexOf('[');
      const toggleOn = toggleTaskMarker(state, pos);
      expect(toggleOn).not.toBeNull();
      const checked = state.update(toggleOn ?? {}).state;
      expect(checked.doc.toString()).toBe('- [x] todo');
      const unchecked = checked.update(toggleTaskMarker(checked, pos) ?? {}).state;
      expect(unchecked.doc.toString()).toBe('- [ ] todo');
    });

    it('unchecks an upper-case [X] and ignores anything that is not a task marker', () => {
      const state = createState('- [X] done');
      const pos = state.doc.toString().indexOf('[');
      expect(state.update(toggleTaskMarker(state, pos) ?? {}).state.doc.toString()).toBe('- [ ] done');
      expect(toggleTaskMarker(state, 0)).toBeNull();
    });
  });

  describe('in an editor', () => {
    let view: EditorView | null = null;

    afterEach(() => {
      view?.destroy();
      view = null;
    });

    it('draws the widgets and toggles a task on mousedown without moving the cursor', () => {
      view = new EditorView({
        state: EditorState.create({ doc: '- [ ] todo', extensions: [promptMarkdownExtension, promptLivePreviewExtension] }),
        parent: document.body,
      });
      expect(view.dom.querySelector('.pf-md-bullet')?.textContent).toBe('•');
      const box = view.dom.querySelector('.pf-md-task');
      expect(box).not.toBeNull();
      box?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      expect(view.state.doc.toString()).toBe('- [x] todo');
      expect(view.state.selection.main.head).toBe(0);
      expect(view.dom.querySelector('.pf-md-task-checked')).not.toBeNull();
    });
  });
});
