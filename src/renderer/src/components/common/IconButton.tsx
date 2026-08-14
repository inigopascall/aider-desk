import { MouseEvent, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

import { Tooltip } from '@/components/ui/Tooltip';

type Props = {
  icon: ReactNode;
  onClick?: () => void;
  tooltip?: ReactNode;
  tooltipMaxWidth?: number | string;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
};

export const IconButton = ({ icon, onClick, tooltip, tooltipMaxWidth, className, disabled, 'aria-label': ariaLabel, 'data-testid': testId }: Props) => {
  const combinedClassName = twMerge(
    'text-text-muted',
    'transition-opacity',
    'focus:outline-none',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:text-text-tertiary',
    className,
  );

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    onClick?.();
  };

  const content = (
    <div onClick={disabled || !onClick ? undefined : handleClick} className={combinedClassName} data-testid={testId} aria-label={ariaLabel}>
      {icon}
    </div>
  );

  if (tooltip) {
    return (
      <Tooltip content={tooltip} maxWidth={tooltipMaxWidth}>
        {content}
      </Tooltip>
    );
  }

  return content;
};
