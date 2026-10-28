import { describe, expect, it } from 'vitest';

import { selectMappingsWithinBudget } from '../mapping-budget';

describe('selectMappingsWithinBudget', () => {
  it('keeps all items when they fit', () => {
    const items = [
      { file: 'a', tokens: 2 },
      { file: 'b', tokens: 3 },
    ];
    expect(selectMappingsWithinBudget(items, 5)).toEqual({ sent: ['a', 'b'], overBudget: [] });
  });

  it('tries later smaller items after an oversized item', () => {
    const items = [
      { file: 'a', tokens: 4 },
      { file: 'b', tokens: 5 },
      { file: 'c', tokens: 1 },
    ];
    expect(selectMappingsWithinBudget(items, 5)).toEqual({ sent: ['a', 'c'], overBudget: [{ file: 'b', tokens: 5 }] });
  });

  it('allows an exact fit to the budget', () => {
    expect(selectMappingsWithinBudget([{ file: 'a', tokens: 7 }], 7)).toEqual({ sent: ['a'], overBudget: [] });
  });

  it('handles empty input', () => {
    expect(selectMappingsWithinBudget([], 10)).toEqual({ sent: [], overBudget: [] });
  });
});
