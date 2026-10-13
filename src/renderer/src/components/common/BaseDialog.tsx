import { FocusTrap } from 'focus-trap-react';
import { CSSProperties, ReactNode, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { twMerge } from 'tailwind-merge';
import { useHotkeys } from 'react-hotkeys-hook';

type Props = {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  contentClass?: string;
  footer?: ReactNode;
  width?: number | 'fit-content';
  minWidth?: number;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  closeButtonText?: string;
  enableFocusTrap?: boolean;
};

export const BaseDialog = ({
  title,
  onClose,
  children,
  contentClass,
  footer,
  width = 500,
  minWidth,
  closeOnEscape = true,
  closeOnBackdrop = false,
  closeButtonText,
  enableFocusTrap = true,
}: Props) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useHotkeys(
    'escape',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
    },
    { enabled: closeOnEscape, enableOnFormTags: true, enableOnContentEditable: true, scopes: 'dialog' },
  );

  const dialogStyle: CSSProperties =
    width === 'fit-content'
      ? {
          width: 'fit-content',
          maxWidth: '100%',
          ...(minWidth !== undefined ? { minWidth: `min(${minWidth}px, 100%)` } : {}),
        }
      : { width: `${width}px` };

  // Lets the trap focus the dialog itself when it contains nothing tabbable, instead of throwing.
  const focusTrapOptions = { allowOutsideClick: true, escapeDeactivates: false, fallbackFocus: () => dialogRef.current! };

  const dialogContent = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      style={dialogStyle}
      className="bg-bg-secondary-light-strongest shadow-2xl rounded-xl border border-bg-tertiary-strong max-h-[90vh] flex flex-col outline-none"
      ref={dialogRef}
    >
      <div className="px-6 py-4 border-b border-bg-tertiary-strong flex-shrink-0">
        <h2 id={headingId} className="text-lg font-medium text-text-primary uppercase">
          {title}
        </h2>
      </div>
      <div
        className={twMerge(
          'p-6 flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-track-bg-secondary-light scrollbar-thumb-bg-fourth scrollbar-thumb-rounded-full',
          contentClass,
        )}
      >
        {children}
      </div>
      <div className="px-6 py-4 border-t border-bg-tertiary-strong flex justify-end space-x-3 flex-shrink-0">
        {footer || (
          <button onClick={onClose} className="bg-bg-fourth text-text-primary px-4 py-2 rounded hover:bg-bg-fifth">
            {closeButtonText || t('common.cancel')}
          </button>
        )}
      </div>
    </div>
  );

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 top-0 bottom-0 left-0 right-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto"
      data-dialog-open="true"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      {enableFocusTrap ? <FocusTrap focusTrapOptions={focusTrapOptions}>{dialogContent}</FocusTrap> : dialogContent}
    </div>,
    document.body,
  );
};
