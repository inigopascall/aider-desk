import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clampPromptAreaFraction,
  computeDraggedPromptAreaFraction,
  isLargePromptArea,
  MAX_PROMPT_AREA_FRACTION,
  MIN_PROMPT_AREA_FRACTION,
  parseStoredPromptAreaFraction,
  PROMPT_AREA_FRACTION_STORAGE_KEY,
  usePromptAreaResize,
} from '../usePromptAreaResize';

const renderResizeHook = () => renderHook(() => usePromptAreaResize({ current: null }, { current: null }));

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

  it('grows the area when its top edge is dragged up and shrinks it when dragged down', () => {
    expect(computeDraggedPromptAreaFraction(200, 500, 400, 1000)).toBeCloseTo(0.3);
    expect(computeDraggedPromptAreaFraction(300, 500, 550, 1000)).toBeCloseTo(0.25);
  });

  it('clamps dragged sizes and ignores an unmeasured container', () => {
    expect(computeDraggedPromptAreaFraction(200, 500, 900, 1000)).toBe(MIN_PROMPT_AREA_FRACTION);
    expect(computeDraggedPromptAreaFraction(200, 500, -1000, 1000)).toBe(MAX_PROMPT_AREA_FRACTION);
    expect(computeDraggedPromptAreaFraction(200, 500, 400, 0)).toBeNull();
  });

  it('counts a maximised or tall prompt area as large', () => {
    expect(isLargePromptArea(null, true)).toBe(true);
    expect(isLargePromptArea(null, false)).toBe(false);
    expect(isLargePromptArea(0.2, false)).toBe(false);
    expect(isLargePromptArea(0.5, false)).toBe(true);
  });
});

describe('usePromptAreaResize', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with no fixed size when nothing is stored', () => {
    const { result } = renderResizeHook();
    expect(result.current.fraction).toBeNull();
    expect(result.current.isResizing).toBe(false);
  });

  it('reads the stored size', () => {
    localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, '0.4');
    const { result } = renderResizeHook();
    expect(result.current.fraction).toBe(0.4);
  });

  it('resets to content height and clears the stored size', () => {
    localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, '0.4');
    const { result } = renderResizeHook();
    act(() => result.current.resetSize());
    expect(result.current.fraction).toBeNull();
    expect(localStorage.getItem(PROMPT_AREA_FRACTION_STORAGE_KEY)).toBeNull();
  });

  it('keeps every mounted instance in step after a reset', () => {
    localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, '0.4');
    const first = renderResizeHook();
    const second = renderResizeHook();
    act(() => first.result.current.resetSize());
    expect(second.result.current.fraction).toBeNull();
  });
});
