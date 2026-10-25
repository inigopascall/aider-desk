import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clampPromptAreaFraction,
  computeDraggedPromptAreaFraction,
  computeSteppedPromptAreaFraction,
  isLargePromptArea,
  MAX_PROMPT_AREA_FRACTION,
  MIN_PROMPT_AREA_FRACTION,
  nextPromptAreaMode,
  parseStoredPromptAreaFraction,
  parseStoredPromptAreaMode,
  PROMPT_AREA_FRACTION_STORAGE_KEY,
  PROMPT_AREA_MODE_STORAGE_KEY,
  slideHeight,
  usePromptAreaResize,
} from '../usePromptAreaResize';

const renderResizeHook = () => renderHook(() => usePromptAreaResize({ current: null }, { current: null }, { current: null }));

const elementWithHeight = (height: number): HTMLDivElement => {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ height }) as DOMRect;
  return element;
};

describe('usePromptAreaResize helpers', () => {
  it('clamps fractions to the allowed range', () => {
    expect(clampPromptAreaFraction(0.01)).toBe(MIN_PROMPT_AREA_FRACTION);
    expect(clampPromptAreaFraction(2)).toBe(MAX_PROMPT_AREA_FRACTION);
    expect(clampPromptAreaFraction(0.5)).toBe(0.5);
  });

  it('treats missing or unusable stored values as no fixed size', () => {
    expect(parseStoredPromptAreaFraction(null)).toBeNull();
    expect(parseStoredPromptAreaFraction('')).toBeNull();
    expect(parseStoredPromptAreaFraction('abc')).toBeNull();
    expect(parseStoredPromptAreaFraction('0')).toBeNull();
    expect(parseStoredPromptAreaFraction('-0.4')).toBeNull();
  });

  it('parses and clamps stored values', () => {
    expect(parseStoredPromptAreaFraction('0.4')).toBe(0.4);
    expect(parseStoredPromptAreaFraction('5')).toBe(MAX_PROMPT_AREA_FRACTION);
    expect(parseStoredPromptAreaFraction('0.05')).toBe(MIN_PROMPT_AREA_FRACTION);
  });

  it('parses the stored mode, defaulting to the user size', () => {
    expect(parseStoredPromptAreaMode('full')).toBe('full');
    expect(parseStoredPromptAreaMode('compact')).toBe('compact');
    expect(parseStoredPromptAreaMode('bogus')).toBe('user');
    expect(parseStoredPromptAreaMode(null)).toBe('user');
  });

  it('cycles user, full, compact and back to user', () => {
    expect(nextPromptAreaMode('user')).toBe('full');
    expect(nextPromptAreaMode('full')).toBe('compact');
    expect(nextPromptAreaMode('compact')).toBe('user');
  });

  it('grows the area when its top edge is dragged up and shrinks it when dragged down', () => {
    expect(computeDraggedPromptAreaFraction(200, 500, 400, 1000)).toBeCloseTo(0.3);
    expect(computeDraggedPromptAreaFraction(300, 500, 550, 1000)).toBeCloseTo(0.25);
  });

  it('clamps dragged sizes and ignores an unmeasured container', () => {
    expect(computeDraggedPromptAreaFraction(200, 500, 900, 1000)).toBe(MIN_PROMPT_AREA_FRACTION);
    expect(computeDraggedPromptAreaFraction(200, 500, -1000, 1000)).toBe(MAX_PROMPT_AREA_FRACTION);
    expect(computeDraggedPromptAreaFraction(200, 500, 400, 0)).toBeNull();
  });

  it('moves the area by one step per grow or shrink press', () => {
    expect(computeSteppedPromptAreaFraction(300, 1, 1000)).toBeCloseTo(0.32);
    expect(computeSteppedPromptAreaFraction(300, -1, 1000)).toBeCloseTo(0.28);
    expect(computeSteppedPromptAreaFraction(100, -1, 1000)).toBe(MIN_PROMPT_AREA_FRACTION);
    expect(computeSteppedPromptAreaFraction(900, 1, 1000)).toBe(MAX_PROMPT_AREA_FRACTION);
    expect(computeSteppedPromptAreaFraction(300, 1, 0)).toBeNull();
  });

  it('counts a full or tall user-sized prompt area as large', () => {
    expect(isLargePromptArea('full', null)).toBe(true);
    expect(isLargePromptArea('user', null)).toBe(false);
    expect(isLargePromptArea('user', 0.2)).toBe(false);
    expect(isLargePromptArea('user', 0.5)).toBe(true);
    expect(isLargePromptArea('compact', 0.5)).toBe(false);
  });
});

describe('slideHeight', () => {
  it('slides from the old height to the rendered height and restores inline styles when finished', () => {
    const element = elementWithHeight(300);
    const companion = document.createElement('div');
    const finish = slideHeight(element, companion, 100, 200);

    expect(element.style.height).toBe('300px');
    expect(element.style.transition).toContain('height');
    expect(element.style.flexGrow).toBe('0');
    expect(companion.style.flexGrow).toBe('1');

    finish();
    expect(element.style.height).toBe('');
    expect(element.style.transition).toBe('');
    expect(element.style.flexGrow).toBe('');
    expect(companion.style.flexGrow).toBe('');
  });

  it('does nothing when the height has not changed', () => {
    const element = elementWithHeight(300);
    slideHeight(element, null, 300);
    expect(element.style.height).toBe('');
    expect(element.style.transition).toBe('');
  });
});

describe('usePromptAreaResize', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts in user mode with no fixed size when nothing is stored', () => {
    const { result } = renderResizeHook();
    expect(result.current.mode).toBe('user');
    expect(result.current.fraction).toBeNull();
    expect(result.current.isResizing).toBe(false);
  });

  it('reads the stored mode and size', () => {
    localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, '0.4');
    localStorage.setItem(PROMPT_AREA_MODE_STORAGE_KEY, 'compact');
    const { result } = renderResizeHook();
    expect(result.current.fraction).toBe(0.4);
    expect(result.current.mode).toBe('compact');
  });

  it('cycles through the modes, keeps the user size and stores the mode', () => {
    localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, '0.4');
    const { result } = renderResizeHook();
    act(() => result.current.cycleMode());
    expect(result.current.mode).toBe('full');
    act(() => result.current.cycleMode());
    expect(result.current.mode).toBe('compact');
    expect(localStorage.getItem(PROMPT_AREA_MODE_STORAGE_KEY)).toBe('compact');
    act(() => result.current.cycleMode());
    expect(result.current.mode).toBe('user');
    expect(result.current.fraction).toBe(0.4);
  });

  it('sets a mode directly', () => {
    const { result } = renderResizeHook();
    act(() => result.current.setMode('full'));
    expect(result.current.mode).toBe('full');
  });

  it('resets to the content height in user mode and clears the stored size', () => {
    localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, '0.4');
    localStorage.setItem(PROMPT_AREA_MODE_STORAGE_KEY, 'full');
    const { result } = renderResizeHook();
    act(() => result.current.resetSize());
    expect(result.current.fraction).toBeNull();
    expect(result.current.mode).toBe('user');
    expect(localStorage.getItem(PROMPT_AREA_FRACTION_STORAGE_KEY)).toBeNull();
  });

  it('steps the size from the measured height and switches to user mode', () => {
    localStorage.setItem(PROMPT_AREA_MODE_STORAGE_KEY, 'compact');
    const { result } = renderHook(() => usePromptAreaResize({ current: elementWithHeight(300) }, { current: elementWithHeight(1000) }, { current: null }));
    act(() => result.current.stepSize(1));
    expect(result.current.mode).toBe('user');
    expect(result.current.fraction).toBeCloseTo(0.32);
  });

  it('keeps every mounted instance in step after a reset', () => {
    localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, '0.4');
    const first = renderResizeHook();
    const second = renderResizeHook();
    act(() => first.result.current.resetSize());
    expect(second.result.current.fraction).toBeNull();
  });
});
