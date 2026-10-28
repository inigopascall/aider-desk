import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResponseMessageBlock } from '../ResponseMessageBlock';

vi.mock('@/hooks/useParsedContent', () => ({
  useParsedContent: (_baseDir: string, content: string) => content,
}));

const message = {
  content: '  Response content for selection  ',
  reasoning: '',
  finished: true,
} as never;

const renderResponse = (onQuoteSelection = vi.fn()) => {
  const { container } = render(
    <ResponseMessageBlock baseDir="/project" message={message} allFiles={[]} renderMarkdown={false} hideMessageBar onQuoteSelection={onQuoteSelection} />,
  );

  return container.querySelector('[data-response-content]') as HTMLDivElement;
};

const selectionFor = (anchorNode: Node, focusNode: Node, text: string, isCollapsed = false) => ({
  isCollapsed,
  rangeCount: 1,
  anchorNode,
  focusNode,
  getRangeAt: () => document.createRange(),
  toString: () => text,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.querySelectorAll('.quote-selection-fade').forEach((node) => node.remove());
  document.querySelectorAll('[data-external-selection-node]').forEach((node) => node.remove());
});

describe('ResponseMessageBlock quote selection', () => {
  it('does not start quote selection for an ordinary mouse selection', () => {
    const onQuoteSelection = vi.fn();
    const content = renderResponse(onQuoteSelection);
    const textNode = content.firstChild as Text;
    const selection = selectionFor(textNode, textNode, 'Response content');
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    fireEvent.mouseDown(content, { button: 0, ctrlKey: false });
    fireEvent.mouseUp(window, { ctrlKey: false });

    expect(onQuoteSelection).not.toHaveBeenCalled();
    expect(content).not.toHaveClass('quote-selection-source');
  });

  it('quotes a Ctrl selection, flashes it, and removes the active class', () => {
    vi.useFakeTimers();
    const onQuoteSelection = vi.fn();
    const content = renderResponse(onQuoteSelection);
    const textNode = content.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 24);
    range.getClientRects = vi.fn(() => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    const selection = selectionFor(textNode, textNode, '  Response content  ');
    selection.getRangeAt = () => range;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    fireEvent.mouseDown(content, { button: 0, ctrlKey: true });
    expect(content).toHaveClass('quote-selection-source');
    fireEvent.mouseUp(window, { ctrlKey: true });

    expect(onQuoteSelection).toHaveBeenCalledOnce();
    expect(onQuoteSelection).toHaveBeenCalledWith('Response content');
    expect(content).not.toHaveClass('quote-selection-source');
    expect(document.querySelector('.quote-selection-fade')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(document.querySelector('.quote-selection-fade')).not.toBeInTheDocument();
  });

  it('does not quote when Ctrl is released before mouseup', () => {
    const onQuoteSelection = vi.fn();
    const content = renderResponse(onQuoteSelection);
    const textNode = content.firstChild as Text;
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionFor(textNode, textNode, 'Response content') as unknown as Selection);

    fireEvent.mouseDown(content, { button: 0, ctrlKey: true });
    fireEvent.mouseUp(window, { ctrlKey: false });

    expect(onQuoteSelection).not.toHaveBeenCalled();
  });

  it('does not quote a collapsed selection', () => {
    const onQuoteSelection = vi.fn();
    const content = renderResponse(onQuoteSelection);
    const textNode = content.firstChild as Text;
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionFor(textNode, textNode, '', true) as unknown as Selection);

    fireEvent.mouseDown(content, { button: 0, ctrlKey: true });
    fireEvent.mouseUp(window, { ctrlKey: true });

    expect(onQuoteSelection).not.toHaveBeenCalled();
  });

  it('does not quote a selection whose endpoints are outside the response content', () => {
    const onQuoteSelection = vi.fn();
    const content = renderResponse(onQuoteSelection);
    const outside = document.createElement('span');
    outside.dataset.externalSelectionNode = 'true';
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    const insideText = content.firstChild as Text;
    const outsideText = outside.firstChild as Text;
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionFor(outsideText, insideText, 'Response content') as unknown as Selection);

    fireEvent.mouseDown(content, { button: 0, ctrlKey: true });
    fireEvent.mouseUp(window, { ctrlKey: true });

    expect(onQuoteSelection).not.toHaveBeenCalled();
  });
});
