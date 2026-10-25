import { CONTEXT_USAGE_CATEGORY_IDS, ContextFile, ContextUsageCategory, ContextUsageCategoryId, ContextUsageItem, TokensInfoData } from '@common/types';

export const CONTEXT_USAGE_COLORS: Record<ContextUsageCategoryId, string> = {
  systemPrompt: '#8b5cf6',
  rules: '#ec4899',
  tools: '#f59e0b',
  repoMappings: '#14b8a6',
  readOnlyFiles: '#3b82f6',
  editableFiles: '#22c55e',
  conversation: '#94a3b8',
};

/** Smallest on-screen width, in pixels, an item needs before the bar draws a divider beside it. */
export const MIN_DIVIDER_ITEM_PX = 4;

export interface LaidOutItem extends ContextUsageItem {
  /** Offset and width as percentages of the whole bar. */
  leftPercent: number;
  widthPercent: number;
}

export interface LaidOutSegment {
  id: ContextUsageCategoryId;
  /** Raw estimate for the category. */
  tokens: number;
  /** The estimate scaled so that all segments add up to the used total. */
  scaledTokens: number;
  leftPercent: number;
  widthPercent: number;
  items: LaidOutItem[];
}

const toCategories = (itemsByCategory: Partial<Record<ContextUsageCategoryId, ContextUsageItem[]>>): ContextUsageCategory[] =>
  CONTEXT_USAGE_CATEGORY_IDS.map((id) => {
    const items = (itemsByCategory[id] ?? []).filter((item) => item.tokens > 0);
    return {
      id,
      tokens: items.reduce((sum, item) => sum + item.tokens, 0),
      items,
    };
  }).filter((category) => category.tokens > 0);

const toPathKey = (filePath: string): string => filePath.replace(/\\/g, '/').replace(/^\.\//, '');

/** Aider mode: Aider's own accounting, with files split by the read-only flag of the matching context file. */
export const buildAiderCategories = (tokensInfo: TokensInfoData, contextFiles: ContextFile[]): ContextUsageCategory[] => {
  const readOnlyKeys = contextFiles.filter((file) => file.readOnly).map((file) => toPathKey(file.path));
  const isReadOnly = (filePath: string) => {
    const key = toPathKey(filePath);
    return readOnlyKeys.some((readOnlyKey) => key === readOnlyKey || key.endsWith(`/${readOnlyKey}`) || readOnlyKey.endsWith(`/${key}`));
  };

  const fileItems: ContextUsageItem[] = Object.entries(tokensInfo.files ?? {}).map(([filePath, cost]) => ({
    id: filePath,
    label: filePath,
    tokens: cost.tokens,
  }));

  return toCategories({
    systemPrompt: [
      {
        id: 'systemMessages',
        label: '',
        tokens: tokensInfo.systemMessages?.tokens ?? 0,
      },
    ],
    repoMappings: [{ id: 'repoMap', label: '', tokens: tokensInfo.repoMap?.tokens ?? 0 }],
    readOnlyFiles: fileItems.filter((item) => isReadOnly(item.id)),
    editableFiles: fileItems.filter((item) => !isReadOnly(item.id)),
    conversation: [
      {
        id: 'chatHistory',
        label: '',
        tokens: tokensInfo.chatHistory?.tokens ?? 0,
      },
    ],
  });
};

/**
 * Positions the segments and items along the bar. The estimates are scaled so that together they cover exactly
 * the used total; the bar's full width is the context window, or the used total when no window is known.
 */
export const layoutContextUsage = (categories: ContextUsageCategory[], usedTokens: number, maxTokens: number): LaidOutSegment[] => {
  const rawTotal = categories.reduce((sum, category) => sum + category.tokens, 0);
  if (rawTotal <= 0) {
    return [];
  }

  const targetTotal = usedTokens > 0 ? usedTokens : rawTotal;
  const scale = targetTotal / rawTotal;
  const capacity = Math.max(maxTokens, targetTotal);
  const toPercent = (tokens: number) => (tokens * scale * 100) / capacity;

  let left = 0;
  return categories.map((category) => {
    const segmentLeft = left;
    let itemLeft = segmentLeft;
    const items = category.items.map((item) => {
      const widthPercent = toPercent(item.tokens);
      const laidOut: LaidOutItem = {
        ...item,
        leftPercent: itemLeft,
        widthPercent,
      };
      itemLeft += widthPercent;
      return laidOut;
    });
    const widthPercent = toPercent(category.tokens);
    left += widthPercent;
    return {
      id: category.id,
      tokens: category.tokens,
      scaledTokens: Math.round(category.tokens * scale),
      leftPercent: segmentLeft,
      widthPercent,
      items,
    };
  });
};

/** Offsets (percent of the bar) of the dividers between neighbouring items: drawn only where at least one neighbour is wide enough to see. */
export const getDividerOffsets = (segment: LaidOutSegment, barWidthPx: number, minItemPx = MIN_DIVIDER_ITEM_PX): number[] => {
  if (barWidthPx <= 0) {
    return [];
  }

  const minPercent = (minItemPx * 100) / barWidthPx;
  const offsets: number[] = [];
  for (let index = 1; index < segment.items.length; index++) {
    const previous = segment.items[index - 1];
    const current = segment.items[index];
    if (previous.widthPercent >= minPercent || current.widthPercent >= minPercent) {
      offsets.push(current.leftPercent);
    }
  }
  return offsets;
};

/** The segment and item under a horizontal position given as a percentage of the bar, if any. */
export const findItemAt = (segments: LaidOutSegment[], percent: number): { segment: LaidOutSegment; item: LaidOutItem } | null => {
  for (const segment of segments) {
    if (percent >= segment.leftPercent && percent < segment.leftPercent + segment.widthPercent) {
      const item = segment.items.find((candidate) => percent < candidate.leftPercent + candidate.widthPercent) ?? segment.items[segment.items.length - 1];
      return item ? { segment, item } : null;
    }
  }
  return null;
};

/** The auto-compact threshold in tokens: the task's own value, else the percentage of the window capped by the token limit. */
export const getCompactingThresholdTokens = (
  taskThresholdTokens: number | undefined,
  thresholdConfig: { percentage: number; tokens: number },
  maxInputTokens: number,
): number => {
  if (taskThresholdTokens !== undefined && taskThresholdTokens > 0) {
    return taskThresholdTokens;
  }
  if (maxInputTokens <= 0) {
    return 0;
  }
  const percentageThreshold = (maxInputTokens * thresholdConfig.percentage) / 100;
  if (thresholdConfig.tokens > 0) {
    return Math.round(Math.min(percentageThreshold, thresholdConfig.tokens));
  }
  return Math.round(percentageThreshold);
};
