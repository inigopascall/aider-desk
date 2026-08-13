import { MouseEvent } from 'react';
import { MdClose } from 'react-icons/md';
import { CgSpinner } from 'react-icons/cg';
import { clsx } from 'clsx';

import { TaskActivityIndicator } from '@/components/common/TaskActivityIndicator';
import { useSettingsStore } from '@/stores/settingsStore';

export const getProjectTabClassName = (selected: boolean): string =>
  clsx(
    'text-sm pl-3 py-2 pr-1 border-r border-border-dark-light transition-all duration-200 ease-in-out flex items-center gap-3 relative whitespace-nowrap focus:outline-none',
    selected
      ? 'bg-gradient-to-b from-bg-secondary-light to-bg-secondary-light text-text-primary font-medium'
      : 'bg-gradient-to-b from-bg-primary to-bg-primary-light text-text-muted hover:bg-bg-secondary-light-strongest hover:text-text-tertiary',
  );

type Props = {
  baseDir: string;
  isActive: boolean;
  isProcessing?: boolean;
  onClose?: () => void;
};

export const ProjectTabContent = ({ baseDir, isActive, isProcessing = false, onClose }: Props) => {
  const handleClose = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isProcessing) {
      onClose?.();
    }
  };

  const disableCssStreamingAnimations = useSettingsStore((state) => state.settings?.disableCssStreamingAnimations ?? true);

  return (
    <>
      {baseDir.split(/[\\/]/).pop()}
      {onClose && (
        <div
          className={clsx(
            'flex items-center justify-center rounded-full p-1 transition-colors duration-200 z-10',
            isActive ? 'hover:bg-bg-fourth' : 'hover:bg-bg-tertiary-strong',
            isProcessing && 'cursor-default',
          )}
          onClick={handleClose}
        >
          {isProcessing ? (
            <span className="h-3.5 w-3.5 flex items-center justify-center">
              {disableCssStreamingAnimations ? (
                <TaskActivityIndicator active className="relative" />
              ) : (
                <CgSpinner className="h-3.5 w-3.5 animate-spin text-text-primary" />
              )}
            </span>
          ) : (
            <MdClose className="h-3.5 w-3.5 opacity-60 group-hover:opacity-100 transition-opacity duration-200" />
          )}
        </div>
      )}
    </>
  );
};
