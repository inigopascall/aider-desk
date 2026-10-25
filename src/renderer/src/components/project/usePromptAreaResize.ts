import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const PROMPT_AREA_FRACTION_STORAGE_KEY = 'prompt-area-height-fraction';
export const PROMPT_AREA_MODE_STORAGE_KEY = 'prompt-area-mode';
export const MIN_PROMPT_AREA_FRACTION = 0.15;
export const MAX_PROMPT_AREA_FRACTION = 0.85;
/** From this share of the task view upwards, the prompt editor counts as large. */
export const LARGE_PROMPT_AREA_FRACTION = 1 / 3;
/** How far one press, or one key repeat, of the grow and shrink hotkeys moves the prompt area's top edge. */
export const PROMPT_AREA_STEP_PX = 20;
export const PROMPT_AREA_SLIDE_MS = 200;

/**
 * - `user`: the height set by dragging or with the grow/shrink hotkeys, or the content height when none is set.
 * - `full`: the prompt fills the task view below the context usage bar.
 * - `compact`: a fixed height of about six lines.
 */
export type PromptAreaMode = 'user' | 'full' | 'compact';

/** The order in which the cycle hotkey and the expand button step through the modes. */
const PROMPT_AREA_MODE_CYCLE: PromptAreaMode[] = ['user', 'full', 'compact'];

type PromptAreaSize = { mode: PromptAreaMode; fraction: number | null };

const PROMPT_AREA_SIZE_CHANGE_EVENT = 'prompt-area-size-change';

export const clampPromptAreaFraction = (fraction: number): number => Math.min(MAX_PROMPT_AREA_FRACTION, Math.max(MIN_PROMPT_AREA_FRACTION, fraction));

/** Parses a stored fraction. A missing or unusable value means the prompt has no fixed size. */
export const parseStoredPromptAreaFraction = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const fraction = Number(raw);
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return null;
  }
  return clampPromptAreaFraction(fraction);
};

export const parseStoredPromptAreaMode = (raw: string | null): PromptAreaMode => PROMPT_AREA_MODE_CYCLE.find((mode) => mode === raw) ?? 'user';

export const nextPromptAreaMode = (mode: PromptAreaMode): PromptAreaMode =>
  PROMPT_AREA_MODE_CYCLE[(PROMPT_AREA_MODE_CYCLE.indexOf(mode) + 1) % PROMPT_AREA_MODE_CYCLE.length];

/** The prompt area's share of the container after its top edge is dragged from `startY` to `currentY`. */
export const computeDraggedPromptAreaFraction = (startHeight: number, startY: number, currentY: number, containerHeight: number): number | null => {
  if (containerHeight <= 0) {
    return null;
  }
  return clampPromptAreaFraction((startHeight + startY - currentY) / containerHeight);
};

/** The prompt area's share of the container after one grow (`1`) or shrink (`-1`) step. */
export const computeSteppedPromptAreaFraction = (currentHeight: number, direction: 1 | -1, containerHeight: number): number | null => {
  if (containerHeight <= 0) {
    return null;
  }
  return clampPromptAreaFraction((currentHeight + direction * PROMPT_AREA_STEP_PX) / containerHeight);
};

export const isLargePromptArea = (mode: PromptAreaMode, fraction: number | null): boolean =>
  mode === 'full' || (mode === 'user' && fraction !== null && fraction >= LARGE_PROMPT_AREA_FRACTION);

const readStoredSize = (): PromptAreaSize => {
  try {
    return {
      mode: parseStoredPromptAreaMode(localStorage.getItem(PROMPT_AREA_MODE_STORAGE_KEY)),
      fraction: parseStoredPromptAreaFraction(localStorage.getItem(PROMPT_AREA_FRACTION_STORAGE_KEY)),
    };
  } catch {
    return { mode: 'user', fraction: null };
  }
};

const writeStoredSize = ({ mode, fraction }: PromptAreaSize) => {
  try {
    localStorage.setItem(PROMPT_AREA_MODE_STORAGE_KEY, mode);
    if (fraction === null) {
      localStorage.removeItem(PROMPT_AREA_FRACTION_STORAGE_KEY);
    } else {
      localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, String(fraction));
    }
  } catch {
    // Ignore unavailable or restricted localStorage.
  }
  window.dispatchEvent(new Event(PROMPT_AREA_SIZE_CHANGE_EVENT));
};

/** Applies drag styles to the page body and returns a function that restores the previous ones. */
const applyBodyDragStyle = (): (() => void) => {
  const { cursor, userSelect } = document.body.style;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'row-resize';
  return () => {
    document.body.style.userSelect = userSelect;
    document.body.style.cursor = cursor;
  };
};

/**
 * Slides `element` from `fromHeight` to the height it has just been rendered at. While it slides,
 * `companion` (the flexible sibling) absorbs the difference. Inline styles are restored when the
 * slide ends. Returns a function that ends the slide at once.
 */
export const slideHeight = (element: HTMLElement, companion: HTMLElement | null, fromHeight: number, durationMs = PROMPT_AREA_SLIDE_MS): (() => void) => {
  const toHeight = element.getBoundingClientRect().height;
  if (Math.abs(toHeight - fromHeight) < 1) {
    return () => {};
  }

  const { style } = element;
  const saved = { height: style.height, flexGrow: style.flexGrow, overflow: style.overflow, transition: style.transition };
  const savedCompanionFlexGrow = companion?.style.flexGrow ?? '';

  style.transition = 'none';
  style.flexGrow = '0';
  style.overflow = 'hidden';
  style.height = `${fromHeight}px`;
  if (companion) {
    companion.style.flexGrow = '1';
  }
  // Apply the start height before the transition begins.
  void element.offsetHeight;
  style.transition = `height ${durationMs}ms ease`;
  style.height = `${toHeight}px`;

  let finished = false;
  let timer = 0;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    window.clearTimeout(timer);
    element.removeEventListener('transitionend', handleTransitionEnd);
    style.height = saved.height;
    style.flexGrow = saved.flexGrow;
    style.overflow = saved.overflow;
    style.transition = saved.transition;
    if (companion) {
      companion.style.flexGrow = savedCompanionFlexGrow;
    }
  };
  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === 'height') {
      finish();
    }
  };
  element.addEventListener('transitionend', handleTransitionEnd);
  timer = window.setTimeout(finish, durationMs + 50);
  return finish;
};

/**
 * Size state for the prompt area at the bottom of the task view.
 *
 * `fraction` is the share of the container's height the user chose, or `null` when the prompt grows
 * with its content; it applies in `user` mode. One mode and fraction are shared by every task and kept
 * in localStorage. Mode changes slide; drags and hotkey steps move at once.
 *
 * `companionRef` is the flexible sibling (the message list) that gives up or takes the space.
 */
export const usePromptAreaResize = (
  areaRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLElement | null>,
  companionRef: RefObject<HTMLElement | null>,
) => {
  const [size, setSize] = useState<PromptAreaSize>(readStoredSize);
  const [isResizing, setIsResizing] = useState(false);
  const slideFromRef = useRef<number | null>(null);
  const finishSlideRef = useRef<(() => void) | null>(null);

  // Follow changes made in other task views.
  useEffect(() => {
    const syncFromStorage = () => setSize(readStoredSize());
    window.addEventListener(PROMPT_AREA_SIZE_CHANGE_EVENT, syncFromStorage);
    return () => window.removeEventListener(PROMPT_AREA_SIZE_CHANGE_EVENT, syncFromStorage);
  }, []);

  // Slide to the height that a mode change has just rendered.
  useLayoutEffect(() => {
    const fromHeight = slideFromRef.current;
    slideFromRef.current = null;
    const area = areaRef.current;
    if (fromHeight === null || !area) {
      return;
    }
    finishSlideRef.current = slideHeight(area, companionRef.current, fromHeight);
  }, [size.mode, size.fraction, areaRef, companionRef]);

  useEffect(() => () => finishSlideRef.current?.(), []);

  const applySize = useCallback(
    (next: PromptAreaSize, slide: boolean) => {
      if (next.mode === size.mode && next.fraction === size.fraction) {
        return;
      }
      // Measure before ending any running slide, so a new slide starts from where the old one is.
      const fromHeight = areaRef.current?.getBoundingClientRect().height ?? null;
      finishSlideRef.current?.();
      finishSlideRef.current = null;
      slideFromRef.current = slide ? fromHeight : null;
      setSize(next);
      writeStoredSize(next);
    },
    [areaRef, size.mode, size.fraction],
  );

  const cycleMode = useCallback(() => applySize({ ...size, mode: nextPromptAreaMode(size.mode) }, true), [applySize, size]);

  const setMode = useCallback((mode: PromptAreaMode) => applySize({ ...size, mode }, true), [applySize, size]);

  const resetSize = useCallback(() => applySize({ mode: 'user', fraction: null }, true), [applySize]);

  const stepSize = useCallback(
    (direction: 1 | -1) => {
      const area = areaRef.current;
      const container = containerRef.current;
      if (!area || !container) {
        return;
      }
      const fraction = computeSteppedPromptAreaFraction(area.getBoundingClientRect().height, direction, container.getBoundingClientRect().height);
      if (fraction !== null) {
        applySize({ mode: 'user', fraction }, false);
      }
    },
    [applySize, areaRef, containerRef],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const area = areaRef.current;
      const container = containerRef.current;
      if (event.button !== 0 || !area || !container) {
        return;
      }
      event.preventDefault();
      finishSlideRef.current?.();
      finishSlideRef.current = null;

      const handle = event.currentTarget;
      const { pointerId } = event;
      const startY = event.clientY;
      const startHeight = area.getBoundingClientRect().height;
      const containerHeight = container.getBoundingClientRect().height;
      let latestFraction: number | null = null;

      const restoreBodyStyle = applyBodyDragStyle();
      handle.setPointerCapture(pointerId);
      setIsResizing(true);

      const handleMove = (moveEvent: PointerEvent) => {
        const next = computeDraggedPromptAreaFraction(startHeight, startY, moveEvent.clientY, containerHeight);
        if (next !== null) {
          latestFraction = next;
          setSize({ mode: 'user', fraction: next });
        }
      };

      const handleEnd = () => {
        handle.removeEventListener('pointermove', handleMove);
        handle.removeEventListener('pointerup', handleEnd);
        handle.removeEventListener('pointercancel', handleEnd);
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        restoreBodyStyle();
        setIsResizing(false);
        if (latestFraction !== null) {
          writeStoredSize({ mode: 'user', fraction: latestFraction });
        }
      };

      handle.addEventListener('pointermove', handleMove);
      handle.addEventListener('pointerup', handleEnd);
      handle.addEventListener('pointercancel', handleEnd);
    },
    [areaRef, containerRef],
  );

  return { mode: size.mode, fraction: size.fraction, isResizing, startResize, resetSize, cycleMode, setMode, stepSize };
};
