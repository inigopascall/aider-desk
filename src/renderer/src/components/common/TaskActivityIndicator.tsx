import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

const BLINK_INTERVAL_MS = 500;

const isBlinkVisible = () => Math.floor(Date.now() / BLINK_INTERVAL_MS) % 2 === 0;

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

    const updateVisibility = () => {
      setVisible(isBlinkVisible());
    };

    updateVisibility();
    const intervalId = window.setInterval(updateVisibility, BLINK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [active]);

  if (!active || !visible) {
    return null;
  }

  return <span className={clsx('block w-[10px] h-[10px] rounded-full bg-error', className)} aria-label="Task in progress" />;
};
