import { ContextManifestEntry, ContextManifestSection, ContextNotSentReason, ContextPlacement, ContextSectionId, TokensCost } from '@common/types';
import { ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HiChevronDown, HiChevronRight, HiX } from 'react-icons/hi';
import { MdOutlineMap, MdOutlinePublic } from 'react-icons/md';
import { RiEyeOffLine, RiRobot2Line } from 'react-icons/ri';
import { TbPencilOff } from 'react-icons/tb';
import { VscFileCode } from 'react-icons/vsc';
import { clsx } from 'clsx';

import { getEntryFileName, getSelectionState, groupEntriesByFolder } from './contextManifestGroups';

import type { SetContextFileSelection } from './useContextFileSelection';

import { Tooltip } from '@/components/ui/Tooltip';
import { TriState, TriStateCheckbox } from '@/components/common/TriStateCheckbox';
import { useShiftRangeSelection } from '@/hooks/useShiftRangeSelection';

const SECTION_LABEL_KEYS: Record<ContextSectionId, string> = {
  rules: 'contextFiles.sectionRules',
  mappings: 'contextFiles.sectionMappings',
  files: 'contextFiles.sectionFiles',
};

const PLACEMENT_KEYS: Record<ContextPlacement, string> = {
  'system-prompt': 'contextFiles.placementSystemPrompt',
  'messages-before-history': 'contextFiles.placementBeforeHistory',
  'messages-after-history': 'contextFiles.placementAfterHistory',
  'aider-context': 'contextFiles.placementAiderContext',
};

const NOT_SENT_KEYS: Record<Exclude<ContextNotSentReason, 'unselected'>, string> = {
  'profile-excludes-mappings': 'contextFiles.notSentProfileExcludesMappings',
  'aider-mode': 'contextFiles.notSentAiderMode',
  'aider-rule-files-disabled': 'contextFiles.notSentAiderRuleFilesDisabled',
};

const PATH_ONLY_KEY = 'contextFiles.listedPathOnly';

// Fixed-width control slots shared with the other workspace rows: a 16px icon, the 16px checkbox and a
// 24px trailing action slot, so the checkbox column lines up across groups and sections.
const ICON_SLOT_CLASS = 'w-4 h-4 flex items-center justify-center flex-shrink-0';
const ACTION_SLOT_CLASS = 'w-6 h-6 flex-shrink-0';

const getNotSentKey = (reason: ContextNotSentReason | undefined): string | undefined => (reason && reason !== 'unselected' ? NOT_SENT_KEYS[reason] : undefined);

// One notice for the whole section when every selected entry is held back for the same reason.
const getSectionNoticeKey = (section: ContextManifestSection): string | undefined => {
  const selectedEntries = section.entries.filter((entry) => entry.selected);
  if (selectedEntries.length === 0) {
    return undefined;
  }
  const firstReason = selectedEntries[0].notSentReason;
  if (selectedEntries.every((entry) => entry.delivery === 'none' && entry.notSentReason === firstReason)) {
    return getNotSentKey(firstReason);
  }
  if (section.id === 'files' && selectedEntries.every((entry) => entry.delivery === 'path-only')) {
    return PATH_ONLY_KEY;
  }
  return undefined;
};

// Per-row marker for a selected entry that is not sent in full, used when the section has no shared notice.
const getEntryMarkerKey = (entry: ContextManifestEntry): string | undefined => {
  if (!entry.selected) {
    return undefined;
  }
  if (entry.delivery === 'none') {
    return getNotSentKey(entry.notSentReason);
  }
  return entry.delivery === 'path-only' ? PATH_ONLY_KEY : undefined;
};

type Props = {
  section: ContextManifestSection;
  fileTokensInfo?: Record<string, TokensCost> | null;
  actions?: ReactNode;
  emptyContent?: ReactNode;
  removeTooltip?: string;
  onSetSelection: SetContextFileSelection;
  onOpenFile: (path: string) => void;
  onRemoveEntry?: (entry: ContextManifestEntry) => void;
};

export const ContextManifestSectionView = ({
  section,
  fileTokensInfo,
  actions,
  emptyContent,
  removeTooltip,
  onSetSelection,
  onOpenFile,
  onRemoveEntry,
}: Props) => {
  const { t } = useTranslation();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupEntriesByFolder(section.entries), [section.entries]);
  const visiblePaths = useMemo(
    () => groups.flatMap((group) => (collapsedGroups.has(group.key) ? [] : group.entries.map((entry) => entry.path))),
    [groups, collapsedGroups],
  );
  // Each section owns its range anchor, so a shift-click never reaches into another section.
  const { resolveRange } = useShiftRangeSelection(visiblePaths);

  const label = t(SECTION_LABEL_KEYS[section.id]);
  const sentCount = section.entries.filter((entry) => entry.delivery !== 'none').length;
  const sectionState = getSelectionState(section.entries);
  const noticeKey = getSectionNoticeKey(section);

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const setAll = (entries: ContextManifestEntry[], state: TriState) => {
    if (entries.length === 0) {
      return;
    }
    onSetSelection(
      section.id,
      entries.map((entry) => entry.path),
      state !== 'checked',
    );
  };

  const toggleEntry = (entry: ContextManifestEntry, shiftKey: boolean) => {
    onSetSelection(section.id, resolveRange(entry.path, shiftKey), !entry.selected);
  };

  const renderEntryIcon = (entry: ContextManifestEntry) => {
    if (entry.source === 'global-rule') {
      return (
        <Tooltip content={t('contextFiles.globalRule')}>
          <MdOutlinePublic className="w-4 h-4 text-text-muted-light" />
        </Tooltip>
      );
    }
    if (entry.source === 'project-rule') {
      return (
        <Tooltip content={t('contextFiles.projectRule')}>
          <VscFileCode className="w-4 h-4 text-text-muted-light" />
        </Tooltip>
      );
    }
    if (entry.source === 'agent-rule') {
      return (
        <Tooltip content={t('contextFiles.agentRule')}>
          <RiRobot2Line className="w-4 h-4 text-text-muted-light" />
        </Tooltip>
      );
    }
    if (entry.readOnly) {
      return (
        <Tooltip content={t('contextFiles.readOnly')}>
          <TbPencilOff className="w-4 h-4 text-text-muted-light" />
        </Tooltip>
      );
    }
    if (section.id === 'mappings') {
      return (
        <Tooltip content={t('contextFiles.repositoryMappingFile')}>
          <MdOutlineMap className="w-4 h-4 text-text-muted-light" />
        </Tooltip>
      );
    }
    return null;
  };

  const renderRemoveControl = (entry: ContextManifestEntry) => {
    if (!onRemoveEntry) {
      // Keeps the checkbox column aligned with sections that have a remove button.
      return <span className={ACTION_SLOT_CLASS} aria-hidden="true" />;
    }
    const button = (
      <button type="button" onClick={() => onRemoveEntry(entry)} className="px-1 py-1 rounded hover:bg-bg-primary-light text-text-muted hover:text-error-dark">
        <HiX className="w-4 h-4" />
      </button>
    );
    return removeTooltip ? <Tooltip content={removeTooltip}>{button}</Tooltip> : button;
  };

  const renderEntry = (entry: ContextManifestEntry) => {
    const markerKey = noticeKey ? undefined : getEntryMarkerKey(entry);
    const tokenInfo = section.id === 'files' ? fileTokensInfo?.[entry.path] : undefined;
    const tooltip = (
      <div className="flex flex-col">
        <span>{entry.displayPath}</span>
        {tokenInfo && <span>{`${tokenInfo.tokens || 0} ${t('usageDashboard.charts.tokens')}, $${(tokenInfo.cost || 0).toFixed(5)}`}</span>}
      </div>
    );

    return (
      <div key={entry.path} className="flex items-center w-full h-6 pl-5 pr-1 group/item" data-testid="context-entry-row">
        <div className="flex items-center flex-grow min-w-0 gap-1">
          <Tooltip content={tooltip} delayDuration={1000}>
            <button
              type="button"
              className={clsx(
                'select-none text-2xs truncate text-left bg-transparent border-0 p-0 cursor-pointer hover:text-text-tertiary',
                entry.selected ? 'text-text-primary' : 'context-dimmed',
              )}
              onClick={() => onOpenFile(entry.path)}
            >
              {getEntryFileName(entry)}
            </button>
          </Tooltip>
          {markerKey && (
            <Tooltip content={t(markerKey)}>
              <span className="flex items-center flex-shrink-0 text-text-muted" data-testid="context-entry-not-sent">
                <RiEyeOffLine className="w-3 h-3" />
              </span>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className={ICON_SLOT_CLASS}>{renderEntryIcon(entry)}</span>
          <TriStateCheckbox
            state={entry.selected ? 'checked' : 'unchecked'}
            onChange={(shiftKey) => toggleEntry(entry, shiftKey)}
            aria-label={entry.displayPath}
          />
          {renderRemoveControl(entry)}
        </div>
      </div>
    );
  };

  const labelElement = <span className="text-2xs font-semibold uppercase text-text-secondary flex-shrink-0">{label}</span>;

  return (
    <div className="flex flex-col" data-testid={`context-section-${section.id}`}>
      <div className="flex items-center gap-1.5 h-7 pl-2 pr-1 bg-bg-primary-light border-y border-border-dark-light shrink-0">
        <TriStateCheckbox state={sectionState} onChange={() => setAll(section.entries, sectionState)} aria-label={label} />
        {section.id === 'rules' ? <Tooltip content={t('contextFiles.rulesTooltip')}>{labelElement}</Tooltip> : labelElement}
        <span className="text-3xs text-text-muted truncate min-w-0 flex-grow">{t(PLACEMENT_KEYS[section.placement])}</span>
        <span className="text-2xs text-text-tertiary flex-shrink-0">{`${sentCount}/${section.entries.length}`}</span>
        {actions && <div className="flex items-center flex-shrink-0">{actions}</div>}
      </div>
      {noticeKey && (
        <div className="px-2 py-0.5 text-3xs text-text-muted italic" data-testid="context-section-notice">
          {t(noticeKey)}
        </div>
      )}
      {section.entries.length === 0
        ? emptyContent
        : groups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key);
            const groupState = getSelectionState(group.entries);
            return (
              <div key={group.key} className="flex flex-col">
                <div className="flex items-center w-full h-6 pl-1 pr-1" data-testid="context-group-heading">
                  <button
                    type="button"
                    className="flex items-center gap-1 flex-grow min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer"
                    onClick={() => toggleGroupCollapsed(group.key)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? (
                      <HiChevronRight className="w-3 h-3 text-text-muted-dark flex-shrink-0" />
                    ) : (
                      <HiChevronDown className="w-3 h-3 text-text-muted-dark flex-shrink-0" />
                    )}
                    <span className="select-none text-2xs text-text-muted truncate">{group.label}</span>
                  </button>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className={ICON_SLOT_CLASS} aria-hidden="true" />
                    <TriStateCheckbox state={groupState} onChange={() => setAll(group.entries, groupState)} aria-label={group.label} />
                    <span className={ACTION_SLOT_CLASS} aria-hidden="true" />
                  </div>
                </div>
                {!isCollapsed && group.entries.map(renderEntry)}
              </div>
            );
          })}
    </div>
  );
};
