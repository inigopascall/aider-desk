import { describe, expect, it } from 'vitest';
import { ContextUsageCategory, TokensInfoData } from '@common/types';

import { buildAiderCategories, findItemAt, getCompactingThresholdTokens, getDividerOffsets, layoutContextUsage } from '../context-usage-layout';

const category = (id: ContextUsageCategory['id'], itemTokens: number[]): ContextUsageCategory => ({
  id,
  tokens: itemTokens.reduce((sum, tokens) => sum + tokens, 0),
  items: itemTokens.map((tokens, index) => ({
    id: `${id}-${index}`,
    label: `${id}-${index}`,
    tokens,
  })),
});

describe('layoutContextUsage', () => {
  it('scales the estimates so the segments cover exactly the used share of the window', () => {
    const segments = layoutContextUsage([category('systemPrompt', [100]), category('conversation', [50, 50])], 400, 1000);

    expect(segments).toHaveLength(2);
    expect(segments[0].widthPercent + segments[1].widthPercent).toBeCloseTo(40);
    expect(segments[0].scaledTokens).toBe(200);
    expect(segments[1].scaledTokens).toBe(200);
    expect(segments[1].leftPercent).toBeCloseTo(20);
    expect(segments[1].items[0].leftPercent).toBeCloseTo(20);
    expect(segments[1].items[1].leftPercent).toBeCloseTo(30);
    expect(segments[1].items[1].widthPercent).toBeCloseTo(10);
  });

  it('fills the whole bar when the context window is unknown', () => {
    const segments = layoutContextUsage([category('tools', [30]), category('conversation', [70])], 0, 0);

    expect(segments[0].widthPercent + segments[1].widthPercent).toBeCloseTo(100);
    expect(segments[0].scaledTokens).toBe(30);
  });

  it('caps the bar at its full width when usage exceeds the window', () => {
    const segments = layoutContextUsage([category('conversation', [10])], 2000, 1000);

    expect(segments[0].widthPercent).toBeCloseTo(100);
  });

  it('returns no segments when there is nothing to draw', () => {
    expect(layoutContextUsage([], 500, 1000)).toEqual([]);
  });
});

describe('getDividerOffsets', () => {
  it('draws a divider only where a neighbouring item is wide enough to see', () => {
    // Widths: 10%, 0.1%, 0.1%, 10% of a 1000 px bar, i.e. 100 px, 1 px, 1 px, 100 px.
    const [segment] = layoutContextUsage([category('conversation', [100, 1, 1, 100])], 202, 1000);

    const offsets = getDividerOffsets(segment, 1000);

    expect(offsets).toHaveLength(2);
    expect(offsets[0]).toBeCloseTo(10);
    expect(offsets[1]).toBeCloseTo(10.2);
  });

  it('draws nothing before the bar has been measured', () => {
    const [segment] = layoutContextUsage([category('conversation', [100, 100])], 200, 1000);

    expect(getDividerOffsets(segment, 0)).toEqual([]);
  });
});

describe('findItemAt', () => {
  const segments = layoutContextUsage([category('systemPrompt', [100]), category('conversation', [50, 50])], 200, 200);

  it('finds the item under a position', () => {
    expect(findItemAt(segments, 10)?.item.id).toBe('systemPrompt-0');
    expect(findItemAt(segments, 60)?.item.id).toBe('conversation-0');
    expect(findItemAt(segments, 90)?.item.id).toBe('conversation-1');
  });

  it('returns null past the end of the used area', () => {
    const partial = layoutContextUsage([category('conversation', [50])], 50, 100);

    expect(findItemAt(partial, 75)).toBeNull();
  });
});

describe('buildAiderCategories', () => {
  const tokensInfo: TokensInfoData = {
    baseDir: '/project',
    taskId: 'task',
    chatHistory: { tokens: 300, cost: 0 },
    files: {
      'src/a.ts': { tokens: 40, cost: 0 },
      '/project/docs/b.md': { tokens: 60, cost: 0 },
      'src/empty.ts': { tokens: 0, cost: 0 },
    },
    repoMap: { tokens: 0, cost: 0 },
    systemMessages: { tokens: 120, cost: 0 },
  };

  it('splits files by the read-only flag of the matching context file and drops empty buckets', () => {
    const categories = buildAiderCategories(tokensInfo, [{ path: 'docs/b.md', readOnly: true }, { path: 'src/a.ts' }]);

    expect(categories.map((c) => c.id)).toEqual(['systemPrompt', 'readOnlyFiles', 'editableFiles', 'conversation']);
    expect(categories[1].items.map((i) => i.id)).toEqual(['/project/docs/b.md']);
    expect(categories[2].items.map((i) => i.id)).toEqual(['src/a.ts']);
    expect(categories[3].tokens).toBe(300);
  });
});

describe('getCompactingThresholdTokens', () => {
  it('prefers the task threshold', () => {
    expect(getCompactingThresholdTokens(5000, { percentage: 50, tokens: 0 }, 100000)).toBe(5000);
  });

  it('uses the percentage, capped by the token limit', () => {
    expect(getCompactingThresholdTokens(undefined, { percentage: 50, tokens: 0 }, 100000)).toBe(50000);
    expect(getCompactingThresholdTokens(undefined, { percentage: 50, tokens: 20000 }, 100000)).toBe(20000);
  });

  it('is zero without a context window', () => {
    expect(getCompactingThresholdTokens(undefined, { percentage: 50, tokens: 0 }, 0)).toBe(0);
  });
});
