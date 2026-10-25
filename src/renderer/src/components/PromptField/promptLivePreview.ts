import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, type TransactionSpec } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';

/**
 * Obsidian-style live preview for the prompt editor.
 *
 * On every line that is not revealed, markdown symbols are hidden or replaced by widgets, so only
 * the styling from `promptMarkdown.ts` shows. While the editor has focus, every line touched by a
 * selection range is revealed and shows raw markdown; an unfocused editor renders every line. The
 * preview never changes the document, except when a task checkbox is clicked. Widget and line
 * classes are styled in `main.css`, scoped to `.pf-prompt-editor`.
 */

export const QUOTE_LINE_CLASS = 'pf-md-quote-line';
export const FENCE_LINE_CLASS = 'pf-md-fence-line';

/** One decoration the preview wants, before it becomes a CodeMirror decoration. */
export type LivePreviewSpec =
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'bullet'; from: number; to: number }
  | { kind: 'rule'; from: number; to: number }
  | { kind: 'task'; from: number; to: number; checked: boolean }
  | { kind: 'line'; from: number; to: number; className: string };

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];
type DocRange = { from: number; to: number };

const ATX_HEADING = /^ATXHeading[1-6]$/;
const TASK_MARKER = /^\[[ xX]\]$/;
/** Nodes whose content is always left exactly as typed. */
const UNTOUCHED_NODES = new Set(['CodeBlock', 'HTMLBlock', 'Table', 'Image', 'Autolink']);

/** Line numbers that show raw markdown: every line a selection range touches, or none when unfocused. */
export const getRevealedLines = (state: EditorState, focused: boolean): Set<number> => {
  const lines = new Set<number>();
  if (!focused) {
    return lines;
  }
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      lines.add(lineNumber);
    }
  }
  return lines;
};

/**
 * What the preview hides or replaces between the given ranges, given the revealed lines.
 * No hidden or replaced range crosses a line break.
 */
export const computeLivePreview = (
  state: EditorState,
  revealedLines: ReadonlySet<number>,
  ranges: readonly DocRange[] = [{ from: 0, to: state.doc.length }],
): LivePreviewSpec[] => {
  const { doc } = state;
  const specs: LivePreviewSpec[] = [];
  const seen = new Set<string>();

  const add = (spec: LivePreviewSpec) => {
    const key = `${spec.kind}:${spec.from}:${spec.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      specs.push(spec);
    }
  };

  const canReplace = (from: number, to: number) => to > from && !revealedLines.has(doc.lineAt(from).number) && !doc.sliceString(from, to).includes('\n');

  const hide = (from: number, to: number) => {
    if (canReplace(from, to)) {
      add({ kind: 'hide', from, to });
    }
  };

  const addLineClass = (pos: number, className: string) => {
    const line = doc.lineAt(pos);
    if (!revealedLines.has(line.number)) {
      add({ kind: 'line', from: line.from, to: line.from, className });
    }
  };

  const spaceAfter = (pos: number) => (doc.sliceString(pos, pos + 1) === ' ' ? pos + 1 : pos);
  const spaceBefore = (pos: number) => (pos > 0 && doc.sliceString(pos - 1, pos) === ' ' ? pos - 1 : pos);

  const handleHeaderMark = (mark: SyntaxNode) => {
    const heading = mark.parent;
    const opening = heading?.firstChild;
    if (!heading || !opening || !ATX_HEADING.test(heading.name)) {
      return;
    }
    const openingEnd = spaceAfter(opening.to);
    if (opening.from === mark.from) {
      hide(mark.from, openingEnd);
    } else {
      hide(Math.max(spaceBefore(mark.from), openingEnd), mark.to);
    }
  };

  // Only inline links, `[text](url "title")`, are rendered; reference links stay raw.
  const handleLink = (link: SyntaxNode) => {
    const marks = link.getChildren('LinkMark');
    if (marks.length < 4) {
      return;
    }
    const [open, close, paren] = marks;
    const last = marks[marks.length - 1];
    const isInline =
      doc.sliceString(open.from, open.to) === '[' &&
      doc.sliceString(paren.from, paren.to) === '(' &&
      paren.from === close.to &&
      doc.sliceString(last.from, last.to) === ')' &&
      last.to === link.to &&
      close.from > open.to;
    if (isInline) {
      hide(open.from, open.to);
      hide(close.from, link.to);
    }
  };

  const handleBlockquote = (quote: SyntaxNode, range: DocRange) => {
    const first = doc.lineAt(Math.max(quote.from, range.from)).number;
    const last = doc.lineAt(Math.min(quote.to, range.to)).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      addLineClass(doc.line(lineNumber).from, QUOTE_LINE_CLASS);
    }
  };

  // Nothing inside a fenced block is hidden. Its fence lines are muted while no selection touches the block.
  const handleFencedCode = (block: SyntaxNode) => {
    const first = doc.lineAt(block.from).number;
    const last = doc.lineAt(block.to).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      if (revealedLines.has(lineNumber)) {
        return;
      }
    }
    for (const fence of block.getChildren('CodeMark')) {
      addLineClass(fence.from, FENCE_LINE_CLASS);
    }
  };

  const tree = syntaxTree(state);
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (node.name === 'FencedCode') {
          handleFencedCode(node.node);
          return false;
        }
        if (UNTOUCHED_NODES.has(node.name)) {
          return false;
        }
        switch (node.name) {
          case 'HeaderMark':
            handleHeaderMark(node.node);
            return false;
          case 'EmphasisMark':
          case 'StrikethroughMark':
            hide(node.from, node.to);
            return false;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode') {
              hide(node.from, node.to);
            }
            return false;
          case 'QuoteMark':
            hide(node.from, spaceAfter(node.to));
            return false;
          case 'ListMark':
            if (node.node.parent?.parent?.name === 'BulletList' && canReplace(node.from, node.to)) {
              add({ kind: 'bullet', from: node.from, to: node.to });
            }
            return false;
          case 'TaskMarker': {
            const marker = doc.sliceString(node.from, node.to);
            if (TASK_MARKER.test(marker) && canReplace(node.from, node.to)) {
              add({ kind: 'task', from: node.from, to: node.to, checked: marker[1] !== ' ' });
            }
            return false;
          }
          case 'HorizontalRule':
            if (canReplace(node.from, node.to)) {
              add({ kind: 'rule', from: node.from, to: node.to });
            }
            return false;
          case 'Link':
            handleLink(node.node);
            return true;
          case 'Blockquote':
            handleBlockquote(node.node, range);
            return true;
          default:
            return true;
        }
      },
    });
  }
  return specs;
};

/** The change that flips the task marker starting at `pos` between `[ ]` and `[x]`, or null if there is none. */
export const toggleTaskMarker = (state: EditorState, pos: number): TransactionSpec | null => {
  const marker = state.doc.sliceString(pos, pos + 3);
  if (!TASK_MARKER.test(marker)) {
    return null;
  }
  return {
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
    userEvent: 'input.toggle',
  };
};

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'pf-md-bullet';
    bullet.textContent = '•';
    return bullet;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const rule = document.createElement('span');
    rule.className = 'pf-md-hr';
    return rule;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView) {
    const box = document.createElement('span');
    box.className = this.checked ? 'pf-md-task pf-md-task-checked' : 'pf-md-task';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.addEventListener('mousedown', (event) => {
      // Handled here, so the click neither moves the cursor onto the line nor reveals it.
      event.preventDefault();
      event.stopPropagation();
      if (!view.state.facet(EditorView.editable)) {
        return;
      }
      const toggle = toggleTaskMarker(view.state, view.posAtDOM(box));
      if (toggle) {
        view.dispatch(toggle);
      }
    });
    return box;
  }

  ignoreEvent() {
    return true;
  }
}

const hiddenDecoration = Decoration.replace({});
const bulletDecoration = Decoration.replace({ widget: new BulletWidget() });
const ruleDecoration = Decoration.replace({ widget: new RuleWidget() });
const taskDecorations = {
  checked: Decoration.replace({ widget: new TaskCheckboxWidget(true) }),
  unchecked: Decoration.replace({ widget: new TaskCheckboxWidget(false) }),
};
const lineDecorations = new Map<string, Decoration>();

const lineDecoration = (className: string): Decoration => {
  let decoration = lineDecorations.get(className);
  if (!decoration) {
    decoration = Decoration.line({ class: className });
    lineDecorations.set(className, decoration);
  }
  return decoration;
};

/** Turns specs into the decorations to draw and the replaced ranges the cursor skips over. */
export const buildLivePreviewDecorations = (specs: readonly LivePreviewSpec[]): { decorations: DecorationSet; atomic: DecorationSet } => {
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const spec of specs) {
    let replacement: Decoration;
    switch (spec.kind) {
      case 'line':
        decorations.push(lineDecoration(spec.className).range(spec.from));
        continue;
      case 'bullet':
        replacement = bulletDecoration;
        break;
      case 'rule':
        replacement = ruleDecoration;
        break;
      case 'task':
        replacement = spec.checked ? taskDecorations.checked : taskDecorations.unchecked;
        break;
      default:
        replacement = hiddenDecoration;
    }
    const range = replacement.range(spec.from, spec.to);
    decorations.push(range);
    atomic.push(range);
  }
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
};

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    atomic: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.build(update.view);
      }
    }

    build(view: EditorView) {
      const specs = computeLivePreview(view.state, getRevealedLines(view.state, view.hasFocus), view.visibleRanges);
      const { decorations, atomic } = buildLivePreviewDecorations(specs);
      this.decorations = decorations;
      this.atomic = atomic;
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Live preview for the prompt editor. Needs `promptMarkdownExtension` for its syntax tree. */
export const promptLivePreviewExtension: Extension = [
  livePreviewPlugin,
  EditorView.atomicRanges.of((view) => view.plugin(livePreviewPlugin)?.atomic ?? Decoration.none),
];
