import { ContextFile, ContextManifestSection, ContextSectionId, Mode, TokensInfoData } from '@common/types';

import { CONTEXT_USAGE_COLORS, getContextUsageDisplay } from '@/components/project/context-usage-layout';

type EntryTokenUsage = { tokens: number; color: string };

export type ContextFileTokenUsage = {
  totals: Partial<Record<ContextSectionId, number>>;
  entries: Record<ContextSectionId, Record<string, EntryTokenUsage>>;
  maxTokens: number;
};

const normalizePath = (value: string): string => {
  let path = value.replace(/\\/g, '/');
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  return path;
};

const matchesPath = (itemPath: string, entryPath: string, baseDir: string): boolean => {
  const item = normalizePath(itemPath);
  const entry = normalizePath(entryPath);
  if (item === entry) {
    return true;
  }
  const base = normalizePath(baseDir).replace(/\/$/, '');
  const relativeItem = item === base ? '' : item.startsWith(`${base}/`) ? item.slice(base.length + 1) : undefined;
  const relativeEntry = entry === base ? '' : entry.startsWith(`${base}/`) ? entry.slice(base.length + 1) : undefined;
  return relativeItem !== undefined ? relativeItem === entry || relativeItem === relativeEntry : relativeEntry !== undefined && relativeEntry === item;
};

export const buildContextFileTokenUsage = (
  tokensInfo: TokensInfoData | null | undefined,
  mode: Mode,
  sections: ContextManifestSection[],
  baseDir: string,
): ContextFileTokenUsage => {
  const contextFiles: ContextFile[] =
    sections
      .find((section) => section.id === 'files')
      ?.entries.filter((entry) => entry.selected && entry.delivery !== 'none' && entry.status?.kind !== 'over-budget')
      .map((entry) => ({ path: entry.path, readOnly: entry.readOnly })) ?? [];
  const display = getContextUsageDisplay(tokensInfo, mode, contextFiles);
  const result: ContextFileTokenUsage = { totals: {}, entries: { rules: {}, mappings: {}, files: {} }, maxTokens: 0 };
  if (!display.hasBreakdown) {
    return result;
  }

  for (const section of sections) {
    const sectionEntries: Record<string, EntryTokenUsage> = {};
    result.entries[section.id] = sectionEntries;
    const segmentIds = section.id === 'rules' ? ['rules'] : section.id === 'mappings' ? ['repoMappings'] : ['readOnlyFiles', 'editableFiles'];
    const segments = display.segments.filter((segment) => segmentIds.includes(segment.id));
    result.totals[section.id] = section.id === 'files' ? segments.reduce((sum, segment) => sum + segment.scaledTokens, 0) : (segments[0]?.scaledTokens ?? 0);
    for (const segment of segments) {
      for (const item of segment.items) {
        const matches = section.entries.filter(
          (entry) => entry.selected && entry.delivery !== 'none' && entry.status?.kind !== 'over-budget' && matchesPath(item.id, entry.path, baseDir),
        );
        for (const entry of matches) {
          const previous = sectionEntries[entry.path];
          sectionEntries[entry.path] = {
            tokens: (previous?.tokens ?? 0) + item.scaledTokens,
            color: CONTEXT_USAGE_COLORS[segment.id],
          };
          result.maxTokens = Math.max(result.maxTokens, sectionEntries[entry.path].tokens);
        }
      }
    }
  }
  return result;
};
