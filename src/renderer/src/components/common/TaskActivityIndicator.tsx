import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

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
  const [visible, setVisible] = useState(() => active && isBlinkVisible());

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }

    return subscribe(setVisible);
  }, [active]);

  if (!active || !visible) {
    return null;
  }

  return <span className={clsx('block w-[10px] h-[10px] rounded-full bg-error', className)} aria-label="Task in progress" />;
};
