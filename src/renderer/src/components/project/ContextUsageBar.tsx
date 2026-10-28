import { AIDER_MODES, ContextFile, Mode, TaskData } from '@common/types';
import { MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CONTEXT_USAGE_COLORS, findItemAt, getCompactingThresholdTokens, getContextUsageDisplay, getDividerOffsets } from './context-usage-layout';

import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskTokensInfo } from '@/stores/taskStore';
import { useActiveAgentProfile } from '@/utils/agents';
import { formatHumanReadable } from '@/utils/string-utils';

const DEFAULT_THRESHOLD_CONFIG = { percentage: 0, tokens: 0 };
const TOOLTIP_MIN_LEFT_PERCENT = 12;
const TOOLTIP_MAX_LEFT_PERCENT = 88;
const DIVIDER_COLOR = 'rgba(0, 0, 0, 0.3)';
const HOVER_OUTLINE_COLOR = 'rgba(255, 255, 255, 0.9)';

type Props = {
  task: TaskData;
  mode: Mode;
  maxInputTokens: number;
  contextFiles: ContextFile[];
  onScrollToMessage?: (id: string) => void;
};

export const ContextUsageBar = ({ task, mode, maxInputTokens, contextFiles, onScrollToMessage }: Props) => {
  const { t } = useTranslation();
  const visible = useSettingsStore((state) => state.settings?.showContextUsageBar ?? true);
  const globalThresholdConfig = useSettingsStore((state) => state.settings?.taskSettings.contextCompactingThreshold) ?? DEFAULT_THRESHOLD_CONFIG;
  const agentProfile = useActiveAgentProfile(task, task.baseDir);
  const tokensInfo = useTaskTokensInfo(task.id);
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [hoverPercent, setHoverPercent] = useState<number | null>(null);

  const isAiderMode = AIDER_MODES.includes(mode);

  useEffect(() => {
    const element = barRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      setBarWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  const { usedTokens, tokensEstimated, segments } = useMemo(
    () => getContextUsageDisplay(tokensInfo, mode, contextFiles, maxInputTokens),
    [tokensInfo, mode, contextFiles, maxInputTokens],
  );
  const usedPercent = maxInputTokens > 0 ? Math.min((usedTokens / maxInputTokens) * 100, 100) : 0;

  const thresholdTokens = isAiderMode
    ? 0
    : getCompactingThresholdTokens(
        task.contextCompactingThresholdTokens,
        {
          percentage: agentProfile?.autoCompactThresholdPercentage ?? globalThresholdConfig.percentage,
          tokens: agentProfile?.autoCompactThresholdTokens ?? globalThresholdConfig.tokens,
        },
        maxInputTokens,
      );
  const thresholdPercent = maxInputTokens > 0 && thresholdTokens > 0 ? Math.min((thresholdTokens / maxInputTokens) * 100, 100) : null;
  const hovered = hoverPercent === null ? null : findItemAt(segments, hoverPercent);

  if (!visible) {
    return null;
  }

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) {
      setHoverPercent(((event.clientX - rect.left) / rect.width) * 100);
    }
  };

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const percent = ((event.clientX - rect.left) / rect.width) * 100;
    const hit = findItemAt(segments, percent);
    if (hit?.segment.id === 'conversation' && hit.item.scrollTargetId) {
      onScrollToMessage?.(hit.item.scrollTargetId);
    }
  };

  const usageLabel = `${tokensEstimated ? '~' : ''}${t('costInfo.tokenUsage', {
    usedTokens: formatHumanReadable(t, usedTokens),
    maxTokens: maxInputTokens ? formatHumanReadable(t, maxInputTokens) : '?',
  })}${maxInputTokens > 0 ? ` (${Math.round(usedPercent)}%)` : ''}`;

  return (
    <div className="relative flex-shrink-0 px-4 pt-2 pb-1 select-none" data-testid="context-usage-bar">
      <div
        ref={barRef}
        className="relative h-[30px] w-full overflow-hidden rounded-md border border-border-dark-light bg-bg-secondary-light"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverPercent(null)}
        onClick={handleClick}
      >
        {segments.length === 0 && usedPercent > 0 && (
          <div className="absolute inset-y-0 left-0 bg-accent-light opacity-60" style={{ width: `${usedPercent}%` }} />
        )}
        {segments.map((segment) => (
          <div
            key={segment.id}
            className="absolute inset-y-0"
            style={{
              left: `${segment.leftPercent}%`,
              width: `${segment.widthPercent}%`,
              backgroundColor: CONTEXT_USAGE_COLORS[segment.id],
              opacity: hovered && hovered.segment.id !== segment.id ? 0.45 : 0.85,
            }}
          />
        ))}
        {segments.map((segment) =>
          getDividerOffsets(segment, barWidth).map((offset, index) => (
            <div
              key={`${segment.id}-divider-${index}`}
              className="pointer-events-none absolute inset-y-0 w-px"
              style={{ left: `${offset}%`, backgroundColor: DIVIDER_COLOR }}
            />
          )),
        )}
        {segments.slice(1).map((segment) => (
          <div
            key={`${segment.id}-boundary`}
            className="pointer-events-none absolute inset-y-0 w-[2px] bg-bg-primary"
            style={{ left: `${segment.leftPercent}%` }}
          />
        ))}
        {hovered && (
          <div
            className="pointer-events-none absolute inset-y-0 border"
            style={{
              left: `${hovered.item.leftPercent}%`,
              width: `max(${hovered.item.widthPercent}%, 2px)`,
              borderColor: HOVER_OUTLINE_COLOR,
            }}
          />
        )}
        {thresholdPercent !== null && <div className="pointer-events-none absolute inset-y-0 w-[2px] bg-text-muted" style={{ left: `${thresholdPercent}%` }} />}
        <div className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center">
          <span className="rounded bg-bg-primary px-1.5 py-0.5 font-mono text-2xs text-text-primary">{usageLabel}</span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-text-muted-light">
        {segments.map((segment) => (
          <span key={segment.id} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: CONTEXT_USAGE_COLORS[segment.id] }} />
            {t(`costInfo.contextUsage.${segment.id}`)} {formatHumanReadable(t, segment.scaledTokens)}
          </span>
        ))}
        {segments.length === 0 && !isAiderMode && <span>{t('costInfo.contextUsage.noBreakdown')}</span>}
      </div>
      {hovered && hoverPercent !== null && (
        <div
          className="pointer-events-none absolute top-[42px] z-50 w-[280px] rounded-md border border-border-dark-light bg-bg-primary p-2 text-2xs shadow-lg"
          style={{
            left: `${Math.min(Math.max(hoverPercent, TOOLTIP_MIN_LEFT_PERCENT), TOOLTIP_MAX_LEFT_PERCENT)}%`,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-text-primary">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{
                backgroundColor: CONTEXT_USAGE_COLORS[hovered.segment.id],
              }}
            />
            {t(`costInfo.contextUsage.${hovered.segment.id}`)}
          </div>
          {hovered.item.label && <div className="mt-1 break-all text-text-primary">{hovered.item.label}</div>}
          {hovered.item.detail && <div className="text-text-muted-light">{hovered.item.detail}</div>}
          <div className="mt-1 text-text-muted-light">
            {t('costInfo.contextUsage.itemTokens', {
              tokens: formatHumanReadable(t, hovered.item.scaledTokens),
            })}
          </div>
          <div className="text-text-muted-light">
            {t('costInfo.contextUsage.segmentTokens', {
              tokens: formatHumanReadable(t, hovered.segment.scaledTokens),
            })}
          </div>
          {!isAiderMode && <div className="mt-1 text-text-muted-light">{t('costInfo.contextUsage.scaledNote')}</div>}
        </div>
      )}
    </div>
  );
};
