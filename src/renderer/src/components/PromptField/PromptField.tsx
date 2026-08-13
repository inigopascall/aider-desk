/* eslint-disable react-compiler/react-compiler */
import {
  acceptCompletion,
  autocompletion,
  CompletionContext,
  type CompletionResult,
  currentCompletions,
  moveCompletionSelection,
  startCompletion,
} from '@codemirror/autocomplete';
import { EditorView, keymap } from '@codemirror/view';
import { AIDER_MODES, Mode, PromptBehavior, QueuedPromptData, QuestionData, SuggestionMode } from '@common/types';
import { githubDarkInit } from '@uiw/codemirror-theme-github';
import CodeMirror, { Annotation, Prec, type Extension, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useLayoutEffect, type RefObject, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useDebounce } from '@reactuses/core';
import { useHotkeys } from 'react-hotkeys-hook';
import { useTranslation } from 'react-i18next';
import { BiSend } from 'react-icons/bi';
import { MdSave, MdStop, MdMic, MdMicOff, MdOutlineScheduleSend } from 'react-icons/md';
import { AiOutlineClose } from 'react-icons/ai';
import { LuChevronsLeftRight, LuChevronsRightLeft } from 'react-icons/lu';
import { clsx } from 'clsx';
import { parseCommandArgs } from '@common/utils';
import { getSubagentId } from '@common/agent';

import { QueuedPromptsList } from './QueuedPromptsList';
import { usePromptFieldText } from './usePromptFieldText';
import { MilkdownEditor, type MilkdownEditorRef } from './MilkdownEditor';

import { useTaskQueuedPrompts } from '@/stores/taskStore';
import { useMarkdownEditorOverlayStore } from '@/stores/markdownEditorStore';
import { InputHistoryMenu } from '@/components/PromptField/InputHistoryMenu';
import { showErrorNotification } from '@/utils/notifications';
import { useCommands } from '@/hooks/useCommands';
import { useApi } from '@/contexts/ApiContext';
import { useAgents } from '@/contexts/AgentsContext';
import { Tooltip } from '@/components/ui/Tooltip';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';
import { AudioAnalyzer } from '@/components/PromptField/AudioAnalyzer';
import { useResponsive } from '@/hooks/useResponsive';

const External = Annotation.define<boolean>();

const COMMANDS = [
  '/code',
  '/context',
  '/agent',
  '/ask',
  '/architect',
  '/add',
  '/model',
  '/read-only',
  '/clear',
  '/web',
  '/task-info',
  '/undo',
  '/test',
  '/map-refresh',
  '/map',
  '/run',
  '/reasoning-effort',
  '/think-tokens',
  '/copy-context',
  '/tokens',
  '/reset',
  '/drop',
  '/redo',
  '/edit-last',
  '/compact',
  '/smart-compact',
  '/commit',
  '/handoff',
  '/init',
  '/clear-logs',
  '/resolve-conflicts',
  '/subtask',
  '/subagent',
];

const ANSWERS = ['y', 'n', 'a', 'd', 'maybe']; // Added 'maybe' (Branch B)

const HISTORY_MENU_CHUNK_SIZE = 20;
const PLACEHOLDER_COUNT = 20;
const MIN_EXPANDED_EDITOR_FONT_SIZE = 10;
const MAX_EXPANDED_EDITOR_FONT_SIZE = 32;
const EXPANDED_EDITOR_FONT_SIZE_STEP = 0.5;
const DEFAULT_EXPANDED_EDITOR_FONT_SIZE = 16.2;
const EXPANDED_EDITOR_FONT_SIZE_STORAGE_KEY = 'prompt-expanded-editor-font-size';

const isPathLike = (input: string): boolean => {
  const firstWord = input.split(' ')[0];
  return (firstWord.match(/\//g) || []).length >= 2;
};

// The Milkdown serializer can emit <br /> for line breaks. We never want HTML
// in the prompt text, so collapse all <br> variants back to real newlines.
// It also unnecessarily escapes plain punctuation (e.g. `\...?`) during
// serialization; normalize those back so the prompt text stays clean.
// Backslashes used for code, paths, commands, or other intentional Markdown
// escapes are preserved — only the targeted punctuation escapes are collapsed.
const sanitizeMilkdownMarkdown = (markdown: string): string =>
  markdown
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\([.?!,:;])/g, '$1');

const THEME = githubDarkInit({
  settings: {
    fontFamily: 'var(--font-family)',
    background: 'transparent',
    selection: 'var(--color-bg-selection)',
    caret: 'var(--color-text-muted)',
  },
});

const BASIC_SETUP = {
  highlightSelectionMatches: false,
  allowMultipleSelections: false,
  syntaxHighlighting: false,
  lineNumbers: false,
  foldGutter: false,
  completionKeymap: false,
  autocompletion: true,
  highlightActiveLine: false,
};

const EDITOR_THEME_EXTENSION = EditorView.theme({
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-placeholder': {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-scroller': {
    overflowX: 'hidden',
  },
});

export interface PromptFieldRef {
  focus: () => void;
  setText: (text: string) => void;
  appendText: (text: string) => void;
  setImages: (images: string[]) => void;
  toggleExpanded: () => void;
  toggleExpandedEditorMode: () => void;
  toggleExpandedWidth: () => void;
}

type Props = {
  baseDir: string;
  taskId: string;
  processing: boolean;
  isActive: boolean;
  allFiles?: string[];
  words?: string[];
  inputHistory?: string[];
  openModelSelector?: (model?: string) => void;
  openAgentModelSelector?: (model?: string) => void;
  mode: Mode;
  onModeChanged: (mode: Mode) => void;
  runPrompt: (prompt: string, images?: string[]) => void;
  savePrompt: (prompt: string) => Promise<void>;
  showFileDialog: (readOnly: boolean) => void;
  addFiles?: (filePaths: string[], readOnly?: boolean) => void;
  clearMessages: () => void;
  scrapeWeb: (url: string, filePath?: string) => void;
  question?: QuestionData | null;
  answerQuestion: (answer: string) => void;
  removeQueuedPrompt?: (id: string) => void;
  sendQueuedPromptNow?: (id: string) => void;
  reorderQueuedPrompts?: (prompts: QueuedPromptData[]) => void;
  editQueuedPrompt?: (id: string, newText: string) => void;
  interruptResponse: () => void;
  runCommand: (command: string) => void;
  runTests: (testCmd?: string) => void;
  redoLastUserPrompt: () => void;
  editUserMessage: () => void;
  isEditingLastMessage?: boolean;
  canSaveEditedPrompt?: boolean;
  disabled?: boolean;
  promptBehavior: PromptBehavior;
  clearLogMessages: () => void;
  scrollToBottom?: () => void;
  onToggleTaskInfoPanel?: () => void;
  handoffConversation?: (focus?: string) => Promise<void>;
  createSubtask?: (args?: string) => void;
  overlayContainerRef?: RefObject<HTMLDivElement | null>;
};

export const PromptField = forwardRef<PromptFieldRef, Props>(
  (
    {
      baseDir,
      taskId,
      processing = false,
      isActive = false,
      allFiles = [],
      words = [],
      inputHistory = [],
      mode,
      onModeChanged,
      showFileDialog,
      runPrompt,
      savePrompt,
      addFiles,
      clearMessages,
      scrapeWeb,
      question,
      answerQuestion,
      removeQueuedPrompt,
      sendQueuedPromptNow,
      reorderQueuedPrompts,
      editQueuedPrompt,
      interruptResponse,
      runCommand,
      runTests,
      redoLastUserPrompt,
      editUserMessage,
      isEditingLastMessage = false,
      canSaveEditedPrompt = false,
      openModelSelector,
      openAgentModelSelector,
      disabled = false,
      promptBehavior,
      clearLogMessages,
      scrollToBottom,
      onToggleTaskInfoPanel,
      handoffConversation,
      createSubtask,
      overlayContainerRef,
    }: Props,
    ref,
  ) => {
    const { t } = useTranslation();
    const { isMobile } = useResponsive();
    const queuedPrompts = useTaskQueuedPrompts(taskId);
    const [text, setText] = useState('');
    const [pastedImages, setPastedImages] = useState<string[]>([]);
    const debouncedText = useDebounce(text, 100);
    const [isExpanded, setIsExpanded] = useState(false);
    const [expandedEditorFontSize, setExpandedEditorFontSize] = useState(() => {
      try {
        const storedFontSize = Number(localStorage.getItem(EXPANDED_EDITOR_FONT_SIZE_STORAGE_KEY));
        return Number.isFinite(storedFontSize)
          ? Math.min(MAX_EXPANDED_EDITOR_FONT_SIZE, Math.max(MIN_EXPANDED_EDITOR_FONT_SIZE, storedFontSize))
          : DEFAULT_EXPANDED_EDITOR_FONT_SIZE;
      } catch {
        return DEFAULT_EXPANDED_EDITOR_FONT_SIZE;
      }
    });
    // Whether the expanded overlay renders Milkdown (true) or a raw textarea (false).
    // Defaults to rendered mode; session-local, not persisted.
    const [showRenderedEditor, setShowRenderedEditor] = useState(true);
    // Whether the expanded editor overlay is stretched to full viewport width.
    const [isFullWidth, setIsFullWidth] = useState(false);
    // Whether the CSS transition for the width slide should be active.
    // Disabled during initial measurement to avoid an open-time animation.
    const [widthTransitionEnabled, setWidthTransitionEnabled] = useState(false);
    // Cached inset measurements of the central column, used to position the fixed overlay.
    type OverlayInsets = { top: number; bottom: number; left: number; right: number; width: number };
    const [overlayInsets, setOverlayInsets] = useState<OverlayInsets | null>(null);
    const milkdownRef = useRef<MilkdownEditorRef>(null);
    // Ref to the raw textarea used while in raw-editor mode.
    const rawTextareaRef = useRef<HTMLTextAreaElement>(null);
    const expandedEditorScrollRef = useRef<HTMLDivElement>(null);
    // Track whether the expanded overlay was previously open, for focus restoration.
    const wasExpandedRef = useRef(false);
    // When true, the next overlay open should auto-animate to full width once the transition is armed.
    const autoExpandPendingRef = useRef(false);
    const { setText: setSavedText } = usePromptFieldText(baseDir, taskId, (text) => {
      const view = editorRef.current?.view;
      view?.dispatch({
        changes: { from: 0, to: view.state.doc.toString().length, insert: text },
        annotations: [External.of(true)],
      });
      setText(text);
    });
    const [placeholderIndex, setPlaceholderIndex] = useState(1);
    const [historyMenuVisible, setHistoryMenuVisible] = useState(false);
    const [highlightedHistoryItemIndex, setHighlightedHistoryItemIndex] = useState(0);
    const [historyLimit, setHistoryLimit] = useState(HISTORY_MENU_CHUNK_SIZE);
    const [keepHistoryHighlightTop, setKeepHistoryHighlightTop] = useState(false);
    const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
    const [pendingCommand, setPendingCommand] = useState<{
      command: string;
      args?: string;
    } | null>(null);
    const editorRef = useRef<ReactCodeMirrorRef>(null);
    const [customCommands, extensionCommands] = useCommands(baseDir);
    const api = useApi();
    const { getProfiles } = useAgents();

    const subagentProfiles = useMemo(() => {
      return getProfiles(baseDir).filter((p) => p.subagent.enabled);
    }, [getProfiles, baseDir]);

    const {
      isRecording,
      isProcessing,
      startRecording,
      stopRecording,
      transcription,
      error: voiceError,
      resetTranscription,
      voiceAvailable,
      mediaDevicesAvailable,
      mediaStream,
    } = useAudioRecorder();
    const [textBeforeRecording, setTextBeforeRecording] = useState('');

    const setTextWithDispatch = useCallback(
      (newText: string) => {
        const view = editorRef.current?.view;
        view?.dispatch({
          changes: { from: 0, to: view.state.doc.toString().length, insert: newText },
          annotations: [External.of(true)],
        });
        setText(newText);
        setSavedText(newText);
      },
      [setText, setSavedText],
    );

    // Called by Milkdown on every debounced markdown update.
    // Updates React state and IndexedDB only — does NOT touch CodeMirror
    // on every keystroke to avoid feedback loops. CodeMirror is synced once
    // when the overlay closes via closeExpanded.
    const handleMilkdownChange = useCallback(
      (markdown: string) => {
        const clean = sanitizeMilkdownMarkdown(markdown);
        setText(clean);
        setSavedText(clean);
      },
      [setSavedText],
    );

    const openExpanded = useCallback(() => {
      setIsFullWidth(false);
      autoExpandPendingRef.current = promptBehavior.openEditorAtFullWidth ?? true;
      setIsExpanded(true);
    }, [promptBehavior.openEditorAtFullWidth]);

    // Focus the compact CodeMirror prompt editor.
    const focusCompactPrompt = useCallback(() => {
      editorRef.current?.view?.focus();
    }, []);

    // Focus the raw textarea and place the selection at the end.
    const focusRawTextarea = useCallback(() => {
      const textarea = rawTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    }, []);

    const scrollExpandedEditorToBottom = useCallback(() => {
      const scrollContainer = expandedEditorScrollRef.current;
      if (!scrollContainer) return;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }, []);

    const handleExpandedEditorWheel = useCallback(
      (event: React.WheelEvent<HTMLDivElement>) => {
        if (!showRenderedEditor || (!event.ctrlKey && !event.metaKey)) {
          return;
        }

      event.preventDefault();
        setExpandedEditorFontSize((currentSize) =>
          Math.min(
            MAX_EXPANDED_EDITOR_FONT_SIZE,
            Math.max(MIN_EXPANDED_EDITOR_FONT_SIZE, currentSize + (event.deltaY < 0 ? EXPANDED_EDITOR_FONT_SIZE_STEP : -EXPANDED_EDITOR_FONT_SIZE_STEP)),
          ),
        );
      },
      [showRenderedEditor],
    );

    useEffect(() => {
      try {
        localStorage.setItem(EXPANDED_EDITOR_FONT_SIZE_STORAGE_KEY, String(expandedEditorFontSize));
      } catch {
        // Ignore unavailable or restricted localStorage.
      }
    }, [expandedEditorFontSize]);

    // Called when Milkdown has fully initialized its editor instance and view.
    // Requests focus through the editor-ready lifecycle so we never target a
    // stale or unmounted editor.
    const handleMilkdownReady = useCallback(() => {
      // Only focus if the expanded overlay is still open and rendered mode is
      // still selected when the ready callback fires.
      if (!isExpanded || !showRenderedEditor) return;
      // Call focus directly - Milkdown's ready callback already runs after
      // the editor is fully initialized, so no additional deferral is needed.
      milkdownRef.current?.focus();
      requestAnimationFrame(scrollExpandedEditorToBottom);
    }, [isExpanded, showRenderedEditor, scrollExpandedEditorToBottom]);

    // Read the authoritative markdown from Milkdown (covers the sub-200 ms
    // debounce window), push it into CodeMirror, then close the overlay.
    // In raw mode, the current text is already the authoritative value.
    const closeExpanded = useCallback(() => {
      if (showRenderedEditor) {
        const md = milkdownRef.current?.getMarkdown();
        setTextWithDispatch(md !== undefined ? sanitizeMilkdownMarkdown(md) : text);
      } else {
        // Raw mode: the shared `text` state already holds the current textarea value.
        setTextWithDispatch(text);
      }
      setIsFullWidth(false);
      setIsExpanded(false);
    }, [showRenderedEditor, setTextWithDispatch, text]);

    const submitExpanded = useCallback(() => {
      scrollToBottom?.();
      void stopRecording();
      let submittedText = text;
      if (showRenderedEditor) {
        const md = milkdownRef.current?.getMarkdown();
        submittedText = sanitizeMilkdownMarkdown(md !== undefined ? md : text);
      }
      setTextWithDispatch(submittedText);
      const images = pastedImages.length > 0 ? pastedImages : undefined;
      setIsFullWidth(false);
      setIsExpanded(false);
      if (submittedText.trim()) {
        runPrompt(submittedText, images);
        setPastedImages([]);
        setPlaceholderIndex(Math.floor(Math.random() * PLACEHOLDER_COUNT));
      }
    }, [showRenderedEditor, text, setTextWithDispatch, runPrompt, pastedImages, scrollToBottom, stopRecording]);

    // Toggle the expanded editor between constrained central-column width and
    // full viewport width. Only has effect when the overlay is open.
    const toggleEditorWidth = useCallback(() => setIsFullWidth((prev) => !prev), []);

    // Switch from rendered Milkdown mode to raw textarea mode.
    // Reads the current Milkdown value first (capturing any in-flight changes),
    // sanitizes it, then swaps the editor component.
    const switchToRawEditor = useCallback(() => {
      const md = milkdownRef.current?.getMarkdown();
      const clean = sanitizeMilkdownMarkdown(md !== undefined ? md : text);
      setText(clean);
      setSavedText(clean);
      setExpandedEditorFontSize(DEFAULT_EXPANDED_EDITOR_FONT_SIZE);
      setShowRenderedEditor(false);
    }, [text, setSavedText]);

    // Switch from raw textarea mode back to rendered Milkdown mode.
    // The raw textarea's value is already in `text`; we persist it and remount
    // Milkdown with a new key so its defaultValueCtx is seeded with the raw text.
    const switchToRenderedEditor = useCallback(() => {
      setSavedText(text);
      setShowRenderedEditor(true);
    }, [text, setSavedText]);

    // Capture-phase document listener so Escape pre-empts both ProseMirror and
    // the background CodeMirror Escape keymap while the overlay is open.
    useEffect(() => {
      if (!isExpanded) {
        return;
      }
      const handleOverlayKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          submitExpanded();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeExpanded();
        }
      };
      document.addEventListener('keydown', handleOverlayKeyDown, true);

      return () => document.removeEventListener('keydown', handleOverlayKeyDown, true);
    }, [isExpanded, closeExpanded, submitExpanded]);

    // Focus the active editor when the overlay opens.
    // In rendered mode, focus is handled by handleMilkdownReady which waits for
    // Milkdown to fully initialize. In raw mode, focus the textarea once it mounts.
    useEffect(() => {
      if (!isExpanded) return;
      if (!showRenderedEditor) {
        focusRawTextarea();
      }
      requestAnimationFrame(scrollExpandedEditorToBottom);
      // Note: rendered mode focus is handled by handleMilkdownReady
    }, [isExpanded, showRenderedEditor, focusRawTextarea, scrollExpandedEditorToBottom]);

    // Restore focus to CodeMirror when the expanded overlay closes.
    // This effect watches the isExpanded state and focuses the compact prompt
    // only on the transition from open to closed (not on initial mount).
    useEffect(() => {
      if (isExpanded) {
        wasExpandedRef.current = true;
        return;
      }
      // Only act when transitioning from open to closed.
      if (!wasExpandedRef.current) return;
      wasExpandedRef.current = false;
      // Schedule focus restoration after the portal has unmounted.
      const raf = requestAnimationFrame(() => {
        if (isActive) focusCompactPrompt();
      });
      // Cancel if the component unmounts or the overlay reopens before it runs.
      return () => cancelAnimationFrame(raf);
    }, [isExpanded, isActive, focusCompactPrompt]);

    // Measure the central column and position the fixed overlay over it.
    // The transition is armed one frame after the initial paint so the open
    // is instant, but subsequent width toggles slide smoothly.
    useLayoutEffect(() => {
      if (!isExpanded) {
        setWidthTransitionEnabled(false);
        return;
      }
      const el = overlayContainerRef?.current;
      if (!el) return;
      const measure = () => {
        const r = el.getBoundingClientRect();
        setOverlayInsets({
          top: r.top,
          bottom: window.innerHeight - r.bottom,
          left: r.left,
          right: window.innerWidth - r.right,
          width: r.width,
        });
      };
      measure();
      const raf = requestAnimationFrame(() => setWidthTransitionEnabled(true));
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener('resize', measure);
      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        window.removeEventListener('resize', measure);
      };
    }, [isExpanded, overlayContainerRef]);

    // Once the width transition is armed after opening, if auto-full-width is pending,
    // flip to full width so the panel visibly slides from constrained to full width.
    useEffect(() => {
      if (widthTransitionEnabled && autoExpandPendingRef.current) {
        autoExpandPendingRef.current = false;
        setIsFullWidth(true);
      }
    }, [widthTransitionEnabled]);

    // Close the expanded overlay when the task/project becomes inactive.
    // This prevents the portal from staying open and blocking hotkeys when
    // the user switches to a different project or task.
    useEffect(() => {
      if (!isActive && isExpanded) {
        closeExpanded();
      }
    }, [isActive, isExpanded, closeExpanded]);

    // Keep a live ref to the latest closeExpanded so the global overlay store
    // can always invoke the current close handler regardless of identity changes.
    const closeExpandedRef = useRef(closeExpanded);
    useEffect(() => {
      closeExpandedRef.current = closeExpanded;
    }, [closeExpanded]);

    // Mirror the overlay's open state into the global coordination store so
    // navigation owners can force-close it before the destination view paints.
    useEffect(() => {
      const store = useMarkdownEditorOverlayStore.getState();
      if (isExpanded) {
        store.open(taskId, () => closeExpandedRef.current());
      } else {
        store.close(taskId);
      }
    }, [isExpanded, taskId]);

    // Unmount safety: clear the store entry if this field unmounts (e.g. on a
    // task/project switch) so a stale owner can't block future closes.
    useEffect(() => () => useMarkdownEditorOverlayStore.getState().close(taskId), [taskId]);

    useEffect(() => {
      if (text) {
        // we need to set the text when the component mounts and the text is not empty (e.g. Activity use case)
        requestAnimationFrame(() => {
          const view = editorRef.current?.view;
          view?.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.toString().length,
              insert: text,
            },
            annotations: [External.of(true)],
          });
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (voiceError) {
        showErrorNotification(voiceError, false);
      }
    }, [voiceError]);

    useEffect(() => {
      if (isRecording) {
        setTextBeforeRecording(text);
      } else if (transcription) {
        // When recording stops, we reset after a short delay or immediately?
        // We want to keep the text.
        // We just need to reset the recorder state for next time.
        resetTranscription();
        setTextBeforeRecording('');
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRecording]);

    useEffect(() => {
      if ((isRecording || isProcessing) && transcription) {
        const separator = textBeforeRecording && !textBeforeRecording.endsWith(' ') ? ' ' : '';
        setTextWithDispatch(textBeforeRecording + separator + transcription);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transcription, isRecording, isProcessing, textBeforeRecording]);

    const completionSource = useCallback(
      async (context: CompletionContext): Promise<CompletionResult | null> => {
        const word = context.matchBefore(/\S*/);
        const { state } = context;
        const text = state.doc.toString();

        // Check if we're at a command argument position with options (before early return)
        if (text.startsWith('/') && text.includes(' ')) {
          const [command, ...args] = parseCommandArgs(text);
          const allCommands = [...customCommands, ...extensionCommands];
          const cmd = allCommands.find((c) => `/${c.name}` === command);
          const argIndex = text.endsWith(' ') ? args.length : args.length - 1;
          if (cmd?.arguments?.[argIndex]?.options) {
            const currentArg = args[argIndex] ?? '';
            return {
              from: state.doc.length - currentArg.length,
              options: cmd.arguments[argIndex].options.map((opt) => ({
                label: opt,
                type: 'constant',
              })),
              validFor: /^\S*$/,
            };
          }

          if (command === '/subagent' && argIndex === 0) {
            const currentArg = args[0] ?? '';
            const subagentIds = subagentProfiles.map((p) => getSubagentId(p));
            return {
              from: state.doc.length - currentArg.length,
              options: subagentIds.map((id) => ({ label: id, type: 'variable' })),
              validFor: /^\S*$/,
            };
          }
        }

        if (!word || (word.from === word.to && !context.explicit)) {
          return null;
        }

        if (promptBehavior.suggestionMode === SuggestionMode.MentionAtSign && !text.startsWith('/') && !text.includes('@')) {
          return null;
        }

        if (promptBehavior.suggestionMode === SuggestionMode.MentionAtSign) {
          // Handle @-based file suggestions (exclusive)
          const atPos = text.lastIndexOf('@');
          if (atPos >= 0 && (atPos === 0 || /\s/.test(text[atPos - 1]))) {
            return {
              from: atPos + 1,
              options: allFiles.map((file) => ({ label: file, type: 'file' })),
              validFor: /^\S*$/,
            };
          }
        }

        // Handle command suggestions
        if (text.startsWith('/')) {
          if (text.includes(' ')) {
            const [command, ...args] = parseCommandArgs(text);
            const currentArg = args[args.length - 1] ?? '';
            if (command === '/add' || command === '/read-only') {
              const files = await api.getAddableFiles(baseDir, taskId);
              return {
                from: state.doc.length - currentArg.length,
                options: files.map((file) => ({ label: file, type: 'file' })),
                validFor: /^\S*$/,
              };
            }
          } else {
            // Add custom and extension commands to the list
            const allCommands = [...customCommands, ...extensionCommands];
            const customCmds = allCommands.map((cmd) => `/${cmd.name}`);
            return {
              from: 0,
              options: [...COMMANDS, ...customCmds].map((cmd) => ({
                label: cmd,
                type: 'keyword',
              })),
              validFor: /^\/\w*$/,
            };
          }
        }

        return {
          from: word.from,
          options: [...words, ...allFiles].map((w) => ({ label: w, type: 'text' })),
        };
      },
      [customCommands, extensionCommands, promptBehavior.suggestionMode, allFiles, api, baseDir, taskId, words, subagentProfiles],
    );

    const allHistoryItems = useMemo(
      () =>
        historyMenuVisible && debouncedText.trim().length > 0
          ? inputHistory.filter((item) => item.toLowerCase().includes(debouncedText.trim().toLowerCase()))
          : inputHistory,
      [historyMenuVisible, debouncedText, inputHistory],
    );

    const historyItems = useMemo(() => allHistoryItems.slice(0, historyLimit), [allHistoryItems, historyLimit]);

    const loadMoreHistory = useCallback(() => {
      if (historyLimit < allHistoryItems.length) {
        const additional = Math.min(HISTORY_MENU_CHUNK_SIZE, allHistoryItems.length - historyLimit);
        setHistoryLimit((prev) => prev + additional);
        setHighlightedHistoryItemIndex((prev) => prev + 1);
        setKeepHistoryHighlightTop(true);
      }
    }, [historyLimit, allHistoryItems.length]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        editorRef.current?.view?.focus();
      },
      setText: (newText: string) => {
        setTextWithDispatch(newText);
        // Ensure cursor is at the end after setting text
        setTimeout(() => {
          const view = editorRef.current?.view;
          if (view) {
            const end = view.state.doc.length;
            view.dispatch({
              selection: { anchor: end, head: end },
            });
            view.focus();
          }
        }, 0);
      },
      appendText: (textToAppend: string) => {
        const currentText = text;
        const newText = currentText ? `${currentText}\n${textToAppend}` : textToAppend;
        setTextWithDispatch(newText);
        // Ensure cursor is at the end after appending text
        setTimeout(() => {
          if (editorRef.current?.view) {
            const end = editorRef.current.view.state.doc.length;
            editorRef.current.view.dispatch({
              selection: { anchor: end, head: end },
            });
            editorRef.current.view.focus();
          }
        }, 0);
      },
      setImages: (newImages: string[]) => {
        setPastedImages(newImages);
      },
      toggleExpanded: () => {
        if (isExpanded) {
          closeExpanded();
        } else {
          openExpanded();
        }
      },
      toggleExpandedEditorMode: () => {
        // Only act when the expanded overlay is open.
        if (!isExpanded) return;
        if (showRenderedEditor) {
          // Rendered → raw: read the authoritative Milkdown value first,
          // sanitize it, then switch to raw textarea mode.
          // Focus will be handled by the showRenderedEditor effect.
          switchToRawEditor();
        } else {
          // Raw → rendered: persist the raw text, remount Milkdown with the
          // raw value as its defaultValue, and let handleMilkdownReady focus.
          // Focus will be handled by handleMilkdownReady.
          switchToRenderedEditor();
        }
      },
      toggleExpandedWidth: () => {
        // Only act when the expanded overlay is open.
        if (!isExpanded) return;
        setIsFullWidth((prev) => !prev);
      },
    }));

    const prepareForNextPrompt = useCallback(() => {
      setTextWithDispatch('');
      setSavedText('');
      setPendingCommand(null);
      setPastedImages([]);
    }, [setTextWithDispatch, setSavedText]);

    const executeCommand = useCallback(
      (command: string, args?: string): void => {
        switch (command) {
          case '/agent':
          case '/code':
          case '/context':
          case '/ask':
          case '/architect': {
            const newMode = command.slice(1) as Mode;
            onModeChanged(newMode);
            setTextWithDispatch(args || '');
            break;
          }
          case '/add':
            prepareForNextPrompt();
            if (args && addFiles) {
              addFiles(args.split(' '), false);
            } else {
              showFileDialog(false);
            }
            break;
          case '/read-only':
            prepareForNextPrompt();
            if (args && addFiles) {
              addFiles(args.split(' '), true);
            } else {
              showFileDialog(true);
            }
            break;
          case '/model':
            prepareForNextPrompt();
            if (!AIDER_MODES.includes(mode)) {
              openAgentModelSelector?.(args);
            } else {
              openModelSelector?.(args);
            }
            break;
          case '/task-info': {
            prepareForNextPrompt();
            onToggleTaskInfoPanel?.();
            break;
          }
          case '/web': {
            const commandArgs = text.replace('/web', '').trim();
            const firstSpaceIndex = commandArgs.indexOf(' ');
            let url: string;
            let filePath: string | undefined;

            if (firstSpaceIndex === -1) {
              url = commandArgs; // Only URL provided
            } else {
              url = commandArgs.substring(0, firstSpaceIndex);
              filePath = commandArgs.substring(firstSpaceIndex + 1).trim();
              if (filePath === '') {
                filePath = undefined; // If only spaces after URL, treat as no filePath
              }
            }
            prepareForNextPrompt();
            scrapeWeb(url, filePath);
            break;
          }
          case '/clear':
            prepareForNextPrompt();
            clearMessages();
            break;
          case '/redo':
            prepareForNextPrompt();
            redoLastUserPrompt();
            break;
          case '/edit-last':
            prepareForNextPrompt();
            editUserMessage();
            break;
          case '/compact':
            prepareForNextPrompt();
            api.compactConversation(baseDir, taskId, mode, args);
            break;
          case '/smart-compact':
            prepareForNextPrompt();
            void api.smartCompactConversation(baseDir, taskId);
            break;
          case '/handoff': {
            const focus = args || '';
            if (handoffConversation) {
              void handoffConversation(focus);
            }
            prepareForNextPrompt();
            break;
          }
          case '/test': {
            runTests(args);
            break;
          }
          case '/init': {
            if (AIDER_MODES.includes(mode)) {
              showErrorNotification(t('promptField.agentModeOnly'));
              return;
            }
            prepareForNextPrompt();
            void api.initProjectRulesFile(baseDir, taskId, args);
            break;
          }
          case '/clear-logs': {
            prepareForNextPrompt();
            clearLogMessages();
            break;
          }
          case '/resolve-conflicts': {
            prepareForNextPrompt();
            void api.resolveWorktreeConflictsWithAgent(baseDir, taskId);
            break;
          }
          case '/subtask': {
            prepareForNextPrompt();
            createSubtask?.(args);
            break;
          }
          default: {
            setTextWithDispatch('');
            runCommand(`${command.slice(1)} ${args || ''}`);
            break;
          }
        }
      },
      [
        prepareForNextPrompt,
        addFiles,
        mode,
        clearMessages,
        redoLastUserPrompt,
        editUserMessage,
        api,
        baseDir,
        taskId,
        onModeChanged,
        showFileDialog,
        openAgentModelSelector,
        openModelSelector,
        text,
        scrapeWeb,
        runTests,
        t,
        clearLogMessages,
        runCommand,
        onToggleTaskInfoPanel,
        setTextWithDispatch,
        handoffConversation,
        createSubtask,
      ],
    );

    const invokeCommand = useCallback(
      (command: string, args?: string): void => {
        const requiresConfirmation = (command: string): boolean => {
          switch (command) {
            case '/add':
              return promptBehavior.requireCommandConfirmation.add;
            case '/read-only':
              return promptBehavior.requireCommandConfirmation.readOnly;
            case '/model':
              return promptBehavior.requireCommandConfirmation.model;
            case '/code':
            case '/context':
            case '/ask':
            case '/architect':
            case '/agent':
              return promptBehavior.requireCommandConfirmation.modeSwitching;
            default:
              return true;
          }
        };

        if (requiresConfirmation(command)) {
          setPendingCommand({ command, args });
        } else {
          executeCommand(command, args);
        }
      },
      [executeCommand, promptBehavior],
    );

    const handleConfirmCommand = useCallback(() => {
      if (pendingCommand) {
        executeCommand(pendingCommand.command, pendingCommand.args);
        setPendingCommand(null);
      }
    }, [pendingCommand, executeCommand]);

    useEffect(() => {
      if (question) {
        setSelectedAnswer(question.defaultAnswer || 'y');
      }
    }, [question]);

    useEffect(() => {
      setHighlightedHistoryItemIndex(0);
    }, [debouncedText]);

    useEffect(() => {
      if (!disabled && isActive && editorRef.current) {
        editorRef.current.view?.focus();
      }
    }, [isActive, disabled]);

    useEffect(() => {
      if (isExpanded) {
        return;
      }
      const commandMatch = COMMANDS.find((cmd) => {
        // Skip auto-invoke for commands that need additional arguments
        if (cmd === '/subagent') {
          return false;
        }

        if (text === cmd) {
          return true;
        }

        return text.startsWith(`${cmd} `);
      });
      if (commandMatch) {
        invokeCommand(commandMatch, text.split(' ').slice(1).join(' '));
      }
    }, [text, invokeCommand, isExpanded]);

    useEffect(() => {
      setHistoryLimit(Math.min(HISTORY_MENU_CHUNK_SIZE, allHistoryItems.length));
    }, [allHistoryItems.length]);

    useEffect(() => {
      if (keepHistoryHighlightTop) {
        setKeepHistoryHighlightTop(false);
      }
    }, [historyLimit, keepHistoryHighlightTop]);

    const onChange = useCallback(
      (newText: string) => {
        setText(newText);
        setPendingCommand(null);

        if (question) {
          if (question?.answers) {
            const matchedAnswer = question.answers.find((answer) => answer.shortkey.toLowerCase() === newText.toLowerCase());
            if (matchedAnswer) {
              setSelectedAnswer(matchedAnswer.shortkey);
              return;
            } else {
              setSelectedAnswer(null);
            }
          } else if (ANSWERS.includes(newText.toLowerCase())) {
            setSelectedAnswer(newText);
            return;
          } else {
            setSelectedAnswer(null);
          }
        }
      },
      [question],
    );

    const handleBlur = useCallback(() => {
      setSavedText(text);
    }, [setSavedText, text]);

    const handleSubmit = useCallback(() => {
      scrollToBottom?.();
      void stopRecording();
      if (text) {
        if (text.startsWith('/') && !isPathLike(text)) {
          // Check if it's a custom or extension command
          const [cmd, ...args] = parseCommandArgs(text.slice(1));
          const allCommands = [...customCommands, ...extensionCommands];
          const command = allCommands.find((command) => command.name === cmd);

          if (command) {
            void api.runCustomCommand(baseDir, taskId, cmd, args, mode);
            prepareForNextPrompt();
            setPlaceholderIndex(Math.floor(Math.random() * PLACEHOLDER_COUNT));
            return;
          }

          if (!COMMANDS.includes(`/${cmd}`)) {
            showErrorNotification(t('promptField.invalidCommand'));
            return;
          }

          if (cmd === 'subagent') {
            const subagentId = args[0];
            if (!subagentId) {
              showErrorNotification(t('promptField.invalidCommand'));
              return;
            }
            const matchedProfile = subagentProfiles.find((p) => getSubagentId(p) === subagentId || p.name === subagentId);
            if (!matchedProfile) {
              showErrorNotification(`Subagent '${subagentId}' not found`);
              return;
            }
            const subagentPrompt = args.slice(1).join(' ').trim();
            prepareForNextPrompt();
            runCommand(`subagent ${getSubagentId(matchedProfile)} ${subagentPrompt}`);
            return;
          }
        }

        if (pendingCommand) {
          prepareForNextPrompt();
          handleConfirmCommand();
        } else {
          const images = pastedImages.length > 0 ? pastedImages : undefined;
          runPrompt(text, images);
          prepareForNextPrompt();
          setPastedImages([]);
        }
        setPlaceholderIndex(Math.floor(Math.random() * PLACEHOLDER_COUNT));
      }
    }, [
      scrollToBottom,
      stopRecording,
      text,
      pastedImages,
      customCommands,
      extensionCommands,
      api,
      baseDir,
      taskId,
      mode,
      prepareForNextPrompt,
      pendingCommand,
      handleConfirmCommand,
      runPrompt,
      runCommand,
      subagentProfiles,
      t,
    ]);

    const handleSavePrompt = async () => {
      if (text) {
        try {
          await savePrompt(text);
          prepareForNextPrompt();
          setPlaceholderIndex(Math.floor(Math.random() * PLACEHOLDER_COUNT));
        } catch (error) {
          showErrorNotification(t('promptField.saveError', { error: error instanceof Error ? error.message : String(error) }));
        }
      }
    };

    const getAutocompleteDetailLabel = useCallback(
      (item: string): [string | null, boolean] => {
        if (item.startsWith('/')) {
          // Check if it's a custom or extension command
          const commandName = item.slice(1);
          const allCommands = [...customCommands, ...extensionCommands];
          const command = allCommands.find((cmd) => cmd.name === commandName);
          if (command) {
            return [command.description, false];
          }

          if (item === '/init' && AIDER_MODES.includes(mode)) {
            return [t('commands.agentModeOnly'), true];
          }

          return [t(`commands.${item.slice(1)}`), false];
        }

        return [null, false];
      },
      [customCommands, extensionCommands, mode, t],
    );

    const toggleVoice = useCallback(() => {
      if (voiceAvailable && mediaDevicesAvailable && !disabled && !processing) {
        if (isRecording) {
          void stopRecording();
        } else {
          void startRecording();
        }

        return true;
      }
      return false;
    }, [voiceAvailable, mediaDevicesAvailable, disabled, processing, isRecording, stopRecording, startRecording]);

    useHotkeys(
      'alt+v',
      (e) => {
        e.preventDefault();
        toggleVoice();
      },
      {
        enableOnFormTags: true,
        enabled: voiceAvailable && !disabled && !processing,
      },
    );

    const keymapExtension = useMemo(
      () =>
        keymap.of([
          {
            key: 'Alt-v',
            preventDefault: true,
            run: toggleVoice,
          },
          // Determine which key submits based on setting
          ...(() => {
            const enterSubmits = promptBehavior.submitOnEnter ?? false;
            return [
              // Submit binding — Ctrl+Enter by default, Enter if submitOnEnter is true
              {
                key: enterSubmits ? 'Enter' : 'Ctrl-Enter',
                preventDefault: true,
                run: (view: { state: { selection: { main: { head: number } }; doc: { length: number } } }) => {
                  // On mobile, allow default (newline)
                  if (isMobile) {
                    return false;
                  }
                  // Desktop: submit or handle special cases
                  if (question && selectedAnswer) {
                    const answers = question.answers?.map((answer) => answer.shortkey.toLowerCase()) || ANSWERS;
                    if (answers.includes(selectedAnswer.toLowerCase())) {
                      answerQuestion(selectedAnswer);
                      prepareForNextPrompt();
                      return true;
                    }
                  } else if (historyMenuVisible) {
                    setHistoryMenuVisible(false);
                    const newText = historyItems[highlightedHistoryItemIndex];
                    view.dispatch({
                      changes: { from: 0, to: view.state.doc.length, insert: newText },
                      selection: { anchor: newText.length },
                    });
                  } else {
                    handleSubmit();
                  }
                  return true;
                },
              },
              // Newline binding — Enter by default, Ctrl+Enter if submitOnEnter is true
              {
                key: enterSubmits ? 'Ctrl-Enter' : 'Enter',
                preventDefault: true,
                run: (view: { state: { selection: { main: { head: number } } } }) => {
                  const cursorPos = view.state.selection.main.head;
                  view.dispatch({
                    changes: { from: cursorPos, insert: '\n' },
                    selection: { anchor: cursorPos + 1 },
                  });
                  return true;
                },
              },
            ];
          })(),
          {
            key: 'Ctrl-Shift-Enter',
            preventDefault: true,
            run: () => {
              if (isMobile) return false;
              handleSubmit();
              return true;
            },
          },
          {
            key: 'Space',
            run: acceptCompletion,
          },
          {
            key: 'Escape',
            run: () => {
              if (historyMenuVisible) {
                setHistoryMenuVisible(false);
                setHighlightedHistoryItemIndex(-1);
                return true;
              } else if (processing) {
                interruptResponse();
                return true;
              }
              return false;
            },
          },
          {
            key: 'Ctrl-c',
            run: () => {
              if (processing) {
                interruptResponse();
                return true;
              }
              return false;
            },
          },
          {
            key: 'Tab',
            preventDefault: true,
            run: (view) => {
              if (question && selectedAnswer) {
                const answers = question.answers?.map((answer) => answer.shortkey.toLowerCase()) || ANSWERS;
                const currentIndex = answers.indexOf(selectedAnswer.toLowerCase());
                if (currentIndex !== -1) {
                  const nextIndex = (currentIndex + 1 + ANSWERS.length) % ANSWERS.length;
                  setSelectedAnswer(answers[nextIndex]);
                  return true;
                }
              }

              const state = view.state;
              const completions = currentCompletions(state);

              if (!completions.length) {
                return false;
              }
              if (completions.length === 1) {
                moveCompletionSelection(true)(view);
                return acceptCompletion(view);
              }

              return moveCompletionSelection(true)(view);
            },
          },
          {
            key: 'Tab',
            preventDefault: true,
            run: startCompletion,
          },
          {
            key: '/',
            preventDefault: true,
            run: (view) => {
              const cursorPos = view.state.selection.main.head;
              view.dispatch({
                changes: { from: cursorPos, insert: '/' },
                selection: { anchor: cursorPos + 1 },
              });
              if (cursorPos === 0) {
                startCompletion(view);
              }
              return true;
            },
          },
          {
            key: '@',
            preventDefault: true,
            run: (view) => {
              const cursorPos = view.state.selection.main.head;
              const textBeforeCursor = view.state.doc.sliceString(0, cursorPos);

              view.dispatch({
                changes: { from: cursorPos, insert: '@' },
                selection: { anchor: cursorPos + 1 },
              });

              if (!/\S$/.test(textBeforeCursor) && promptBehavior.suggestionMode === SuggestionMode.MentionAtSign) {
                startCompletion(view);
              }
              return true;
            },
          },

          {
            key: 'ArrowUp',
            run: () => {
              if (historyItems.length > 0) {
                if (historyMenuVisible) {
                  if (highlightedHistoryItemIndex === historyItems.length - 1) {
                    loadMoreHistory();
                  } else {
                    setHighlightedHistoryItemIndex((prev) => Math.min(prev + 1, historyItems.length - 1));
                  }
                  return true;
                } else if (!text) {
                  setHistoryLimit(HISTORY_MENU_CHUNK_SIZE);
                  setHistoryMenuVisible(true);
                  setHighlightedHistoryItemIndex(0);
                  return true;
                }
              }
              return false;
            },
          },
          {
            key: 'ArrowDown',
            run: () => {
              if (historyMenuVisible) {
                setHighlightedHistoryItemIndex((prev) => Math.max(prev - 1, 0));
                return true;
              }
              return false;
            },
          },
        ]),
      [
        toggleVoice,
        isMobile,
        question,
        selectedAnswer,
        answerQuestion,
        prepareForNextPrompt,
        historyMenuVisible,
        historyItems,
        highlightedHistoryItemIndex,
        setHistoryMenuVisible,
        handleSubmit,
        processing,
        interruptResponse,
        text,
        loadMoreHistory,
        promptBehavior.suggestionMode,
        promptBehavior.submitOnEnter,
      ],
    );

    const handlePaste = useCallback(
      (event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.indexOf('image') !== -1) {
              const file = item.getAsFile();
              if (file) {
                if (!AIDER_MODES.includes(mode)) {
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    const dataUrl = e.target?.result as string;
                    if (dataUrl) {
                      setPastedImages((prev) => [...prev, dataUrl]);
                    }
                  };
                  reader.readAsDataURL(file);
                } else {
                  file.arrayBuffer().then((buffer) => {
                    api.pasteImage(baseDir, taskId, buffer);
                  });
                }
              } else {
                if (AIDER_MODES.includes(mode)) {
                  api.pasteImage(baseDir, taskId);
                }
              }
              break;
            }
          }
        }
      },
      [api, baseDir, taskId, mode],
    );

    const [vimExtension, setVimExtension] = useState<Extension | null>(null);

    useEffect(() => {
      if (promptBehavior.useVimBindings && !vimExtension) {
        void import('@replit/codemirror-vim').then((module) => {
          setVimExtension(module.vim());
        });
      }
    }, [promptBehavior.useVimBindings, vimExtension]);

    const extensions = useMemo(
      () => [
        EDITOR_THEME_EXTENSION,
        promptBehavior.useVimBindings && vimExtension ? vimExtension : keymap.of([]),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          paste: handlePaste,
        }),
        autocompletion({
          override: question || historyMenuVisible ? [] : [completionSource],
          activateOnTyping: promptBehavior.suggestionMode === SuggestionMode.Automatically || promptBehavior.suggestionMode === SuggestionMode.MentionAtSign,
          activateOnTypingDelay: promptBehavior.suggestionDelay,
          aboveCursor: true,
          icons: false,
          selectOnOpen: false,
          tooltipClass: () => (isMobile ? '' : 'max-w-[60vw]'),
          addToOptions: [
            {
              render: (completion) => {
                const [detail, showInChip] = getAutocompleteDetailLabel(completion.label);
                if (!detail) {
                  return null;
                }

                const element = document.createElement('span');
                element.className = showInChip
                  ? 'cm-tooltip-autocomplete-chip whitespace-pre-wrap text-right'
                  : 'cm-tooltip-autocomplete-detail whitespace-pre-wrap text-right';
                element.innerText = detail;
                return element;
              },
              position: 100,
            },
          ],
        }),
        Prec.high(keymapExtension),
      ],
      [
        promptBehavior.useVimBindings,
        promptBehavior.suggestionMode,
        promptBehavior.suggestionDelay,
        vimExtension,
        question,
        historyMenuVisible,
        completionSource,
        isMobile,
        getAutocompleteDetailLabel,
        keymapExtension,
        handlePaste,
      ],
    );

    // Position the fixed expanded-editor overlay over the central column using
    // the measured insets. When full-width is active, the left/right insets are
    // overridden to 0 so the panel stretches edge-to-edge; the transition makes
    // the width slide smooth once measurement has completed.
    const panelStyle: CSSProperties = overlayInsets
      ? {
          top: overlayInsets.top,
          bottom: overlayInsets.bottom,
          left: isFullWidth ? 0 : overlayInsets.left,
          right: isFullWidth ? 0 : overlayInsets.right,
          transition: widthTransitionEnabled ? 'left 300ms ease, right 300ms ease' : undefined,
        }
      : { top: 0, right: 0, bottom: 0, left: 0 };

    return (
      <div className="w-full relative">
        {queuedPrompts && queuedPrompts.length > 0 && (
          <QueuedPromptsList
            queuedPrompts={queuedPrompts}
            onRemove={removeQueuedPrompt}
            onSendNow={sendQueuedPromptNow}
            onReorder={reorderQueuedPrompts}
            onEdit={editQueuedPrompt}
          />
        )}
        {question && (
          <div className="mb-2 p-3 bg-gradient-to-b from-bg-primary to-bg-primary-light rounded-md border border-border-default-dark text-sm">
            <div className="text-text-primary text-sm mb-2 whitespace-pre-wrap">{question.text}</div>
            {question.subject && (
              <div className="text-text-muted-light text-xs mb-3 whitespace-pre-wrap max-h-[50vh] overflow-y-auto scrollbar-thin scrollbar-thumb-bg-tertiary scrollbar-track-bg-primary-light scrollbar-rounded">
                {question.subject}
              </div>
            )}
            <div className="flex gap-2">
              {question.answers && question.answers.length > 0 ? (
                question.answers.map((answer, index) => (
                  <button
                    key={index}
                    onClick={() => answerQuestion(answer.shortkey)}
                    className={`px-2 py-0.5 text-xs rounded hover:bg-bg-tertiary border border-border-default ${selectedAnswer === answer.shortkey ? 'bg-bg-tertiary border-border-light' : 'bg-bg-secondary'}`}
                  >
                    {answer.text}
                  </button>
                ))
              ) : (
                <>
                  <button
                    onClick={() => answerQuestion('y')}
                    className={`px-2 py-0.5 text-xs rounded hover:bg-bg-tertiary border border-border-default ${selectedAnswer === 'y' ? 'bg-bg-tertiary border-accent-secondary' : 'bg-bg-secondary'}`}
                    title="Yes (Y)"
                  >
                    {t('promptField.answers.yes')}
                  </button>
                  <button
                    onClick={() => answerQuestion('n')}
                    className={`px-2 py-0.5 text-xs rounded hover:bg-bg-tertiary border border-border-default ${selectedAnswer === 'n' ? 'bg-bg-tertiary border-border-light' : 'bg-bg-secondary'}`}
                    title={t('promptField.answers.no')}
                  >
                    {t('promptField.answers.no')}
                  </button>
                  <button
                    onClick={() => answerQuestion('a')}
                    className={`px-2 py-0.5 text-xs rounded hover:bg-bg-tertiary border border-border-default ${selectedAnswer === 'a' ? 'bg-bg-tertiary border-border-light' : 'bg-bg-secondary'}`}
                    title={t('promptField.answers.always')}
                  >
                    {t('promptField.answers.always')}
                  </button>
                  <button
                    onClick={() => answerQuestion('d')}
                    className={`px-2 py-0.5 text-xs rounded hover:bg-bg-tertiary border border-border-default ${selectedAnswer === 'd' ? 'bg-bg-tertiary border-border-light' : 'bg-bg-secondary'}`}
                    title={t('promptField.answers.dontAsk')}
                  >
                    {t('promptField.answers.dontAsk')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {pastedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 p-2 bg-bg-secondary rounded-md border border-border-default-dark">
            {pastedImages.map((dataUrl, index) => (
              <div key={index} className="relative group">
                <img
                  src={dataUrl}
                  alt={t('promptField.pastedImage', { index: index + 1 })}
                  className="h-20 rounded border border-border-dark-light object-contain"
                />
                <button
                  onClick={() => setPastedImages((prev) => prev.filter((_, i) => i !== index))}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-bg-tertiary rounded-full flex items-center justify-center text-text-muted-light hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <AiOutlineClose className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative flex-shrink-0">
          <CodeMirror
            ref={useCallback((instance: ReactCodeMirrorRef) => {
              editorRef.current = instance;
            }, [])}
            onChange={onChange}
            onBlur={handleBlur}
            placeholder={question ? t('promptField.questionPlaceholder') : t(`promptField.placeholders.${placeholderIndex}`)}
            editable={!disabled}
            spellCheck={false}
            className={clsx(
              'w-full px-2 py-1 border-2 border-border-default-dark rounded-md focus:outline-none focus:border-border-accent text-sm bg-bg-secondary text-text-primary placeholder-text-muted-dark resize-none overflow-y-auto transition-colors duration-200 max-h-[40vh] scrollbar-thin scrollbar-track-bg-secondary-light scrollbar-thumb-bg-fourth hover:scrollbar-thumb-bg-fourth',
              voiceAvailable ? (isRecording ? 'pr-24' : 'pr-20') : 'pr-16',
              !text && '!h-[40px]',
            )}
            theme={THEME}
            basicSetup={BASIC_SETUP}
            indentWithTab={false}
            extensions={extensions}
          />
          <div className="absolute right-2 top-1.5 flex items-center gap-0.5 text-text-muted-light">
            {text.trim() && !isRecording && !processing && (!isEditingLastMessage || canSaveEditedPrompt) && (
              <Tooltip content={t('promptField.savePrompt')}>
                <button
                  onClick={handleSavePrompt}
                  disabled={disabled}
                  className="text-text-muted-light hover:text-text-tertiary hover:bg-bg-tertiary rounded p-1 transition-all duration-200"
                >
                  <MdSave className="w-4 h-4" />
                </button>
              </Tooltip>
            )}
            {text.trim() && !isRecording && !processing && (
              <Tooltip content={isProcessing ? t('promptField.queueMessage') : t('promptField.sendMessage')}>
                <button onClick={handleSubmit} disabled={disabled} className="hover:text-text-tertiary hover:bg-bg-tertiary rounded p-1 transition-all duration-200">
                  {isProcessing && !question ? <MdOutlineScheduleSend className="w-4 h-4" /> : <BiSend className="w-4 h-4" />}
                </button>
              </Tooltip>
            )}
          </div>
          <div className="absolute right-3 top-1/2 -translate-y-[12px] flex items-center space-x-1 text-text-muted-light">
            {processing && (
              <Tooltip content={`${t('promptField.stopResponse')} (Ctrl+C)`}>
                <button onClick={() => interruptResponse()} className="hover:text-text-tertiary hover:bg-bg-tertiary rounded p-1 transition-colors duration-200 ml-1">
                  <MdStop className="w-4 h-4" />
                </button>
              </Tooltip>
            )}
            {isRecording && mediaStream && <AudioAnalyzer stream={mediaStream} />}
            {voiceAvailable && (
              <Tooltip
                content={
                  mediaDevicesAvailable
                    ? `${isRecording ? t('promptField.stopRecording') : t('promptField.startRecording')} (Alt+V)`
                    : t('promptField.voiceUnavailable')
                }
              >
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  disabled={disabled || isProcessing || !mediaDevicesAvailable}
                  className={clsx(
                    'rounded p-1',
                    mediaDevicesAvailable
                      ? 'text-text-muted-light hover:text-text-tertiary hover:bg-bg-tertiary transition-all duration-200'
                      : 'text-text-muted-dark',
                    isRecording ? 'text-accent-primary animate-pulse' : '',
                  )}
                >
                  {isProcessing ? (
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : isRecording ? (
                    <MdMicOff className="w-4 h-4" />
                  ) : (
                    <MdMic className="w-4 h-4" />
                  )}
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        {historyMenuVisible && historyItems.length > 0 && (
          <InputHistoryMenu
            items={historyItems}
            highlightedIndex={highlightedHistoryItemIndex}
            keepHighlightAtTop={keepHistoryHighlightTop}
            onScrollTop={loadMoreHistory}
            onSelect={(item) => {
              setTextWithDispatch(item);
              setHistoryMenuVisible(false);
            }}
            onClose={() => setHistoryMenuVisible(false)}
          />
        )}
        {isExpanded &&
          createPortal(
            <div className="fixed z-50 flex flex-col bg-bg-secondary shadow-2xl" style={panelStyle}>
              <div className="flex items-center justify-between px-4 py-2 border-b border-border-dark-light flex-shrink-0">
                <span className="text-sm text-text-primary">
                  {t('promptField.editorTitle', {
                    mode: showRenderedEditor ? t('promptField.editorModeRendered') : t('promptField.editorModeRaw'),
                  })}
                </span>
                <div className="flex items-center gap-1">
                  <Tooltip content={isFullWidth ? t('promptField.collapseEditorWidth') : t('promptField.expandEditorWidth')}>
                    <button
                      onClick={toggleEditorWidth}
                      className="text-text-muted-light hover:text-text-tertiary hover:bg-bg-tertiary rounded p-1 transition-all duration-200"
                      aria-label={isFullWidth ? t('promptField.collapseEditorWidth') : t('promptField.expandEditorWidth')}
                    >
                      {isFullWidth ? <LuChevronsRightLeft className="w-5 h-5" /> : <LuChevronsLeftRight className="w-5 h-5" />}
                    </button>
                  </Tooltip>
                  {/* Toggle between rendered Milkdown and raw textarea mode */}
                  <Tooltip content={showRenderedEditor ? t('promptField.switchToRawEditor') : t('promptField.switchToRenderedEditor')}>
                    <button
                      onClick={showRenderedEditor ? switchToRawEditor : switchToRenderedEditor}
                      className="text-text-muted-light hover:text-text-tertiary hover:bg-bg-tertiary rounded p-1 transition-all duration-200"
                      aria-label={showRenderedEditor ? t('promptField.switchToRawEditor') : t('promptField.switchToRenderedEditor')}
                    >
                      {showRenderedEditor ? (
                        // Raw mode icon: represents plain text
                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                          <polyline points="10 9 9 9 8 9" />
                        </svg>
                      ) : (
                        // Rendered mode icon: represents preview/rendered view
                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </Tooltip>
                  <Tooltip content={t('promptField.closeEditor')}>
                    <button
                      onClick={closeExpanded}
                      className="text-text-muted-light hover:text-text-tertiary hover:bg-bg-tertiary rounded p-1 transition-all duration-200"
                    >
                      <AiOutlineClose className="w-5 h-5" />
                    </button>
                  </Tooltip>
                </div>
              </div>
              <div
                ref={expandedEditorScrollRef}
                onWheel={handleExpandedEditorWheel}
                className="flex-grow overflow-y-auto scrollbar-thin scrollbar-track-bg-secondary scrollbar-thumb-bg-fourth"
              >
                <div
                  className="w-full mx-auto flex flex-col px-6 py-6 pb-16 min-h-full milkdown-prompt-editor"
                  style={
                    {
                      maxWidth: overlayInsets ? overlayInsets.width : undefined,
                      '--prompt-editor-font-size': `${expandedEditorFontSize}px`,
                    } as CSSProperties
                  }
                >
                  {showRenderedEditor ? (
                    // Remount Milkdown when switching back to rendered mode via a mode-dependent key
                    // so its defaultValueCtx is seeded with the current raw text.
                    <MilkdownEditor key={showRenderedEditor ? 'rendered' : 'raw'} ref={milkdownRef} initialValue={text} onChange={handleMilkdownChange} onReady={handleMilkdownReady} />
                  ) : (
                    <textarea
                      ref={rawTextareaRef}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setSavedText(e.target.value);
                        setPendingCommand(null);
                      }}
                      onBlur={() => setSavedText(text)}
                      placeholder={t('promptField.questionPlaceholder')}
                      spellCheck={false}
                      className="w-full flex-1 min-h-[200px] bg-transparent text-text-primary placeholder-text-muted-dark resize-none overflow-y-auto scrollbar-thin scrollbar-track-bg-secondary scrollbar-thumb-bg-fourth focus:outline-none"
                      style={{ fontFamily: 'var(--font-family)', fontSize: '1rem' }}
                      rows={1}
                    />
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )}
      </div>
    );
  },
);

PromptField.displayName = 'PromptField';
