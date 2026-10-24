import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { CgSpinner } from 'react-icons/cg';
import { ApplicationAPI } from '@common/api';
import {
  TOPIC_COMPACTION_LEVELS,
  TaskData,
  TopicCompactionOptions,
  TopicCompactionPreview,
  TopicCompactionTarget,
  getTaskSummary,
  normalizeTopicCompactionLevel,
} from '@common/types';

import { TranslatedText, estimateWords, getCompactionErrorText, getCompactionReasonKey } from './compaction-utils';
import { getCompactingPlaceholderId } from './compaction-view';

import { Button } from '@/components/common/Button';
import { TextArea } from '@/components/common/TextArea';
import { useApi } from '@/contexts/ApiContext';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';
import { showErrorNotification } from '@/utils/notifications';

/** Delay before scrolling, so the conversation has rendered the placeholder or the recap. */
const SCROLL_DELAY_MS = 120;

type Translate = (key: string, values?: Record<string, unknown>) => string;

type RunTopicCompactionOptions = {
  api: ApplicationAPI;
  baseDir: string;
  taskId: string;
  target: TopicCompactionTarget;
  preview: TopicCompactionPreview;
  options: TopicCompactionOptions;
  onScrollToMessage: (messageId: string) => void;
  translate: Translate;
};

/** Id of the recap that a compaction of the target wrote, read from the task data the engine returned. */
export const getRecapMessageId = (task: TaskData | null | undefined, target: TopicCompactionTarget): string | undefined => {
  const topic = task ? getTaskSummary(task)?.topics[target.topicIndex] : undefined;
  const compaction = target.sectionIndex === undefined ? topic?.compaction : topic?.sections?.[target.sectionIndex]?.compaction;
  return compaction?.summaryMessageId;
};

const scrollSoon = (onScrollToMessage: (messageId: string) => void, messageId: string) => {
  window.setTimeout(() => onScrollToMessage(messageId), SCROLL_DELAY_MS);
};

/** Shows the "Compacting…" placeholder in place of the stretch, compacts the target, then scrolls to the recap. */
export const runTopicCompaction = async ({ api, baseDir, taskId, target, preview, options, onScrollToMessage, translate }: RunTopicCompactionOptions) => {
  const firstMessageId = preview.firstMessageId ?? target.firstMessageId;
  const nonce = useTaskNavigationStore.getState().startPendingCompaction(firstMessageId, preview.endBeforeMessageId ?? null);
  scrollSoon(onScrollToMessage, getCompactingPlaceholderId(nonce));
  try {
    const task = await api.compactTopic(baseDir, taskId, target, options);
    useTaskNavigationStore.getState().endPendingCompaction(firstMessageId, nonce);
    const recapId = getRecapMessageId(task, target);
    if (recapId) {
      scrollSoon(onScrollToMessage, recapId);
    }
  } catch (error) {
    useTaskNavigationStore.getState().endPendingCompaction(firstMessageId, nonce);
    const text = getCompactionErrorText(error, 'taskNavigation.compaction.compactFailed');
    showErrorNotification(translate(text.key, text.values));
  }
};

type PreviewState = { status: 'loading' } | { status: 'ready'; preview: TopicCompactionPreview } | { status: 'error'; text: TranslatedText };

type Props = {
  baseDir: string;
  taskId: string;
  target: TopicCompactionTarget;
  title: string;
  onCancel: () => void;
  /** Called once the compaction starts, before the recap is written. */
  onStarted: () => void;
  onScrollToMessage: (messageId: string) => void;
};

/**
 * Options of a topic compaction, docked at the bottom of the topic map: the level of detail and optional instructions.
 * ←/→ or 1–5 choose the level, Tab moves to and from the instructions, Enter (Ctrl/Cmd+Enter in the instructions) starts
 * the compaction, Esc goes back to the list.
 */
export const TopicCompactionPanel = ({ baseDir, taskId, target, title, onCancel, onStarted, onScrollToMessage }: Props) => {
  const { t } = useTranslation();
  const api = useApi();
  const storedLevel = useTaskNavigationStore((state) => state.compactionLevel);
  const setCompactionLevel = useTaskNavigationStore((state) => state.setCompactionLevel);
  const [level, setLevel] = useState(() => normalizeTopicCompactionLevel(storedLevel));
  const [instructions, setInstructions] = useState('');
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const panelRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewTopicCompaction(baseDir, taskId, target)
      .then((preview) => {
        if (!cancelled) {
          setState({ status: 'ready', preview });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ status: 'error', text: getCompactionErrorText(error, 'taskNavigation.compaction.compactFailed') });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, baseDir, taskId, target]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const preview = state.status === 'ready' ? state.preview : undefined;
  const compactable = !!preview?.compactable;

  const confirm = () => {
    if (!preview?.compactable) {
      return;
    }
    const trimmed = instructions.trim();
    setCompactionLevel(level);
    onStarted();
    void runTopicCompaction({
      api,
      baseDir,
      taskId,
      target,
      preview,
      options: trimmed ? { level, instructions: trimmed } : { level },
      onScrollToMessage,
      translate: (key, values) => t(key, values),
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inTextArea = event.target === textAreaRef.current;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) {
      return;
    }
    if (event.key === 'Tab') {
      if (compactable) {
        event.preventDefault();
        event.stopPropagation();
        if (inTextArea) {
          panelRef.current?.focus();
        } else {
          textAreaRef.current?.focus();
        }
      }
      return;
    }
    if (event.key === 'Enter') {
      if (inTextArea && !event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (compactable) {
        confirm();
      } else if (state.status !== 'loading') {
        onCancel();
      }
      return;
    }
    if (inTextArea || !compactable || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      setLevel((current) => normalizeTopicCompactionLevel(current + step));
    } else if (/^[1-5]$/.test(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      setLevel(Number(event.key));
    }
  };

  const renderBody = () => {
    if (state.status === 'loading') {
      return (
        <div className="flex items-center gap-2 py-1">
          <CgSpinner className="w-3.5 h-3.5 animate-spin" />
          <span>{t('taskNavigation.compaction.panel.loading')}</span>
        </div>
      );
    }
    if (state.status === 'error') {
      return <div className="py-1 text-xs text-text-primary">{t(state.text.key, state.text.values)}</div>;
    }
    if (!state.preview.compactable) {
      const reasonKey = getCompactionReasonKey(state.preview.reason ?? 'not-found');
      return <div className="py-1 text-xs text-text-primary">{t(reasonKey)}</div>;
    }
    const { targetCharacters } = state.preview;
    return (
      <>
        <div className="grid grid-cols-5 gap-1.5">
          {TOPIC_COMPACTION_LEVELS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === level}
              onClick={() => setLevel(option)}
              className={clsx(
                'rounded border px-2 py-1.5 text-left flex flex-col gap-0.5',
                option === level ? 'border-accent-primary bg-bg-tertiary' : 'border-border-default hover:bg-bg-tertiary',
              )}
            >
              <span className="text-xs font-medium text-text-primary">{`${option} · ${t(`taskNavigation.compaction.panel.levels.${option}`)}`}</span>
              <span>{t('taskNavigation.compaction.panel.words', { words: estimateWords(targetCharacters[option] ?? 0) })}</span>
            </button>
          ))}
        </div>
        <div className="truncate">{t(`taskNavigation.compaction.panel.levelDescriptions.${level}`)}</div>
        <TextArea
          ref={textAreaRef}
          rows={2}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t('taskNavigation.compaction.panel.instructionsPlaceholder')}
          aria-label={t('taskNavigation.compaction.panel.instructions')}
          className="text-xs resize-none"
        />
      </>
    );
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="topic-compaction-panel"
      onKeyDown={handleKeyDown}
      className="px-3 py-2 border-t border-bg-tertiary-strong flex flex-col gap-2 text-2xs text-text-muted focus:outline-none"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-1 min-w-0 truncate text-xs text-text-primary">{title}</span>
        {preview?.compactable && (
          <span className="shrink-0">
            {t('taskNavigation.compaction.panel.size', { count: preview.messageCount, words: estimateWords(preview.sourceCharacters) })}
          </span>
        )}
      </div>
      <div className="min-h-[136px] flex flex-col gap-2">{renderBody()}</div>
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate">{compactable ? t('taskNavigation.compaction.panel.hint') : ''}</span>
        {compactable ? (
          <>
            <Button variant="text" size="xs" onClick={onCancel}>
              {t('taskNavigation.compaction.panel.cancel')}
            </Button>
            <Button size="xs" onClick={confirm}>
              {t('taskNavigation.compaction.panel.confirm')}
            </Button>
          </>
        ) : (
          <Button variant="text" size="xs" onClick={onCancel}>
            {t('taskNavigation.compaction.panel.close')}
          </Button>
        )}
      </div>
    </div>
  );
};
