import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useState } from 'react';

export const PROMPT_AREA_FRACTION_STORAGE_KEY = 'prompt-area-height-fraction';
export const MIN_PROMPT_AREA_FRACTION = 0.15;
export const MAX_PROMPT_AREA_FRACTION = 0.85;
/** From this share of the task view upwards, the prompt editor counts as large. */
export const LARGE_PROMPT_AREA_FRACTION = 1 / 3;

const PROMPT_AREA_FRACTION_CHANGE_EVENT = 'prompt-area-height-fraction-change';

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

/** The prompt area's share of the container after its top edge is dragged from `startY` to `currentY`. */
export const computeDraggedPromptAreaFraction = (startHeight: number, startY: number, currentY: number, containerHeight: number): number | null => {
  if (containerHeight <= 0) {
    return null;
  }
  return clampPromptAreaFraction((startHeight + startY - currentY) / containerHeight);
};

export const isLargePromptArea = (fraction: number | null, maximized: boolean): boolean =>
  maximized || (fraction !== null && fraction >= LARGE_PROMPT_AREA_FRACTION);

const readStoredFraction = (): number | null => {
  try {
    return parseStoredPromptAreaFraction(localStorage.getItem(PROMPT_AREA_FRACTION_STORAGE_KEY));
  } catch {
    return null;
  }
};

const writeStoredFraction = (fraction: number | null) => {
  try {
    if (fraction === null) {
      localStorage.removeItem(PROMPT_AREA_FRACTION_STORAGE_KEY);
    } else {
      localStorage.setItem(PROMPT_AREA_FRACTION_STORAGE_KEY, String(fraction));
    }
  } catch {
    // Ignore unavailable or restricted localStorage.
  }
  window.dispatchEvent(new Event(PROMPT_AREA_FRACTION_CHANGE_EVENT));
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
 * Drag-to-resize state for the prompt area at the bottom of the task view.
 *
 * `fraction` is the prompt area's share of the container's height, or `null` when the
 * prompt grows with its content. One value is shared by every task. It is kept in
 * localStorage and written when a drag ends.
 */
export const usePromptAreaResize = (areaRef: RefObject<HTMLElement | null>, containerRef: RefObject<HTMLElement | null>) => {
  const [fraction, setFraction] = useState<number | null>(readStoredFraction);
  const [isResizing, setIsResizing] = useState(false);

  // Follow changes made in other task views.
  useEffect(() => {
    const syncFromStorage = () => setFraction(readStoredFraction());
    window.addEventListener(PROMPT_AREA_FRACTION_CHANGE_EVENT, syncFromStorage);
    return () => window.removeEventListener(PROMPT_AREA_FRACTION_CHANGE_EVENT, syncFromStorage);
  }, []);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const area = areaRef.current;
      const container = containerRef.current;
      if (event.button !== 0 || !area || !container) {
        return;
      }
      event.preventDefault();

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
          setFraction(next);
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
          writeStoredFraction(latestFraction);
        }
      };

      handle.addEventListener('pointermove', handleMove);
      handle.addEventListener('pointerup', handleEnd);
      handle.addEventListener('pointercancel', handleEnd);
    },
    [areaRef, containerRef],
  );

  const resetSize = useCallback(() => {
    setFraction(null);
    writeStoredFraction(null);
  }, []);

  return { fraction, isResizing, startResize, resetSize };
};
