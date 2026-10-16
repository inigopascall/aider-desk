import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

import { useSettingsStore } from '@/stores/settingsStore';

const BLINK_INTERVAL_MS = 500;

const isBlinkVisible = () => Math.floor(Date.now() / BLINK_INTERVAL_MS) % 2 === 0;

const subscribers = new Set<(visible: boolean) => void>();
let blinkTimeoutId: number | undefined;
let blinkIntervalId: number | undefined;

const notifySubscribers = () => {
  const visible = isBlinkVisible();
  subscribers.forEach((update) => update(visible));
};

const subscribe = (update: (visible: boolean) => void) => {
  subscribers.add(update);

  if (subscribers.size === 1) {
    notifySubscribers();

    const delay = BLINK_INTERVAL_MS - (Date.now() % BLINK_INTERVAL_MS);
    blinkTimeoutId = window.setTimeout(() => {
      blinkTimeoutId = undefined;
      notifySubscribers();
      blinkIntervalId = window.setInterval(notifySubscribers, BLINK_INTERVAL_MS);
    }, delay);
  }

  return () => {
    subscribers.delete(update);

    if (subscribers.size === 0) {
      if (blinkTimeoutId !== undefined) {
        window.clearTimeout(blinkTimeoutId);
        blinkTimeoutId = undefined;
      }
      if (blinkIntervalId !== undefined) {
        window.clearInterval(blinkIntervalId);
        blinkIntervalId = undefined;
      }
    }
  };
};

type Props = {
  active: boolean;
  className?: string;
};

export const TaskActivityIndicator = ({ active, className }: Props) => {
  const disableCssStreamingAnimations = useSettingsStore((state) => state.settings?.disableCssStreamingAnimations ?? true);
  const isActive = active && disableCssStreamingAnimations;
  const [visible, setVisible] = useState(() => isActive && isBlinkVisible());

  useEffect(() => {
    if (!isActive) {
      setVisible(false);
      return;
    }

    return subscribe(setVisible);
  }, [isActive]);

  if (!isActive) {
    return null;
  }

  // Always keep the dot mounted while active and toggle only its visibility,
  // so the blink never adds or removes a box from the layout.
  return (
    <span
      className={clsx('block w-[10px] h-[10px] flex-shrink-0 rounded-full bg-error', !visible && 'invisible', className)}
      aria-label="Task in progress"
    />
  );
};
