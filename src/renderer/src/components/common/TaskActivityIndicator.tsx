import { useEffect, useState } from 'react';

type Props = {
  active: boolean;
};

export const TaskActivityIndicator = ({ active }: Props) => {
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

  return <span className="block w-[6px] h-[6px] rounded-full bg-error-light" aria-label="Task in progress" />;
};
