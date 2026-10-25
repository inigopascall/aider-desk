import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { highlightTree } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';

import { findFencedCodeLineStarts, promptMarkdownExtension, promptMarkdownHighlightStyle } from '../promptMarkdown';

const createState = (doc: string) => EditorState.create({ doc, extensions: [promptMarkdownExtension] });

/** Every highlight class applied at the first character of `needle` in `doc`. */
const classesAt = (doc: string, needle: string): string[] => {
  const state = createState(doc);
  const pos = doc.indexOf(needle);
  expect(pos).toBeGreaterThanOrEqual(0);
  const classes = new Set<string>();
  highlightTree(syntaxTree(state), promptMarkdownHighlightStyle, (from, to, cls) => {
    if (from <= pos && pos < to) {
      cls
        .split(' ')
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    }
  });
  return [...classes];
};

describe('promptMarkdown', () => {
  it('marks headings by level and fades the heading marker', () => {
    expect(classesAt('# Title', 'Title')).toEqual(expect.arrayContaining(['pf-md-heading', 'pf-md-h1']));
    expect(classesAt('## Section', 'Section')).toEqual(expect.arrayContaining(['pf-md-heading', 'pf-md-h2']));
    expect(classesAt('# Title', '#')).toContain('pf-md-mark');
  });

  it('marks bold and italic text', () => {
    expect(classesAt('some **bold** text', 'bold')).toContain('pf-md-strong');
    expect(classesAt('some **bold** text', '**')).toContain('pf-md-mark');
    expect(classesAt('some _slanted_ text', 'slanted')).toContain('pf-md-emphasis');
  });

  it('marks inline code and links', () => {
    expect(classesAt('run `npm test` now', 'npm')).toContain('pf-md-code');
    expect(classesAt('see [the docs](https://example.com)', 'the docs')).toContain('pf-md-link');
  });

  it('leaves plain text unmarked', () => {
    expect(classesAt('just plain words', 'plain')).toEqual([]);
  });

  it('finds every line of a fenced code block', () => {
    const state = createState('intro\n```ts\nconst a = 1;\n```\nafter');
    expect(findFencedCodeLineStarts(state)).toEqual([2, 3, 4].map((lineNumber) => state.doc.line(lineNumber).from));
  });

  it('limits fenced code lines to the requested range', () => {
    const state = createState('intro\n```\none\ntwo\n```\nafter');
    const line = state.doc.line(3);
    expect(findFencedCodeLineStarts(state, line.from, line.to)).toEqual([line.from]);
  });
});
