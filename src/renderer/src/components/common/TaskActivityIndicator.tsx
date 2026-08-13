import { useEffect, useState } from 'react';
import { clsx } from 'clsx';

type Props = {
  active: boolean;
  className?: string;
};

export const TaskActivityIndicator = ({ active, className }: Props) => {
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const intervalId = window.setInterval(() => {
      setVisible((current) => !current);
    }, 500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [active]);

  if (!active || !visible) {
    return null;
  }

  return <span className={clsx('absolute block w-[15px] h-[15px] rounded-full bg-error', className)} aria-label="Task in progress" />;
};
