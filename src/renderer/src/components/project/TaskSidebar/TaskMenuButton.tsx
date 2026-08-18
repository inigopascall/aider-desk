import { DefaultTaskState, TaskData } from '@common/types';
import { useTranslation } from 'react-i18next';
import { MouseEvent, useRef, useState, useEffect, memo } from 'react';
import { HiCheck, HiOutlinePencil, HiOutlineTrash } from 'react-icons/hi';
import { FaEllipsisVertical } from 'react-icons/fa6';
import { IoLogoMarkdown } from 'react-icons/io';
import { RiFlag2Line } from 'react-icons/ri';
import { MdClose, MdImage, MdPushPin, MdVerticalAlignTop } from 'react-icons/md';
import { BiDuplicate, BiArchive, BiArchiveIn, BiCopy } from 'react-icons/bi';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';

import { useClickOutside } from '@/hooks/useClickOutside';
import { getTaskStateLabel } from '@/components/common/TaskStateChip';

const TASK_HIGHLIGHT_COLORS = ['#E74C3C', '#E67E22', '#F1C40F', '#2ECC71', '#3498DB', '#9B59B6'];

type Props = {
  task: TaskData;
  onEdit: () => void;
  onDelete?: () => void;
  onCopyAsMarkdown?: () => void;
  onExportToMarkdown?: () => void;
  onExportToImage?: () => void;
  onDuplicateTask?: () => void;
  onArchiveTask?: () => void;
  onUnarchiveTask?: () => void;
  onTogglePin?: () => void;
  onChangeState?: (newState: string) => void;
  onMoveToTop?: () => void;
  onHighlightChange?: (color: string | null) => void;
  isPinned?: boolean;
};

export const TaskMenuButton = memo(
  ({
    task,
    onEdit,
    onDelete,
    onCopyAsMarkdown,
    onExportToMarkdown,
    onExportToImage,
    onDuplicateTask,
    onArchiveTask,
    onUnarchiveTask,
    onTogglePin,
    onChangeState,
    onMoveToTop,
    onHighlightChange,
    isPinned,
  }: Props) => {
    const { t } = useTranslation();
    const isNewTask = !task.createdAt;
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!isMenuOpen || !buttonRef.current) {
        setMenuPosition(null);
        return;
      }

      const updateMenuPosition = () => {
        if (!buttonRef.current) {
          return;
        }

        const rect = buttonRef.current.getBoundingClientRect();
        const menu = menuRef.current;
        const menuWidth = menu?.offsetWidth ?? 170;
        const menuHeight = menu?.offsetHeight ?? 400;
        const margin = 8;
        const gap = 4;

        const left = Math.min(
          Math.max(margin, rect.right - menuWidth),
          Math.max(margin, window.innerWidth - menuWidth - margin),
        );

        const availableBelow = window.innerHeight - rect.bottom - margin;
        const availableAbove = rect.top - margin;
        const shouldOpenAbove = availableBelow < menuHeight && availableAbove > availableBelow;
        const availableHeight = shouldOpenAbove ? availableAbove - gap : availableBelow - gap;
        const top = shouldOpenAbove
          ? Math.max(margin, rect.top - Math.min(menuHeight, availableAbove) - gap)
          : Math.min(rect.bottom + gap, window.innerHeight - margin - Math.min(menuHeight, availableBelow));

        setMenuPosition({
          top,
          left,
        });

        if (menu) {
          menu.style.maxHeight = `${Math.max(120, availableHeight)}px`;
        }
      };

      updateMenuPosition();
      window.addEventListener('resize', updateMenuPosition);
      window.addEventListener('scroll', updateMenuPosition, true);

      return () => {
        window.removeEventListener('resize', updateMenuPosition);
        window.removeEventListener('scroll', updateMenuPosition, true);
      };
    }, [isMenuOpen]);



    useClickOutside(
      [menuRef, buttonRef],
      () => {
        setIsMenuOpen(false);
      },
      isMenuOpen,
    );

    const handleMenuClick = () => {
      if (!isMenuOpen) {
        setIsMenuOpen(true);
      }
    };

    const handleEditClick = (e: MouseEvent) => {
      e.stopPropagation();
      onEdit();
    };

    const handleDeleteClick = (e: MouseEvent) => {
      e.stopPropagation();
      onDelete?.();
    };

    const handleCopyAsMarkdownClick = (e: MouseEvent) => {
      e.stopPropagation();
      onCopyAsMarkdown?.();
    };

    const handleExportToMarkdownClick = (e: MouseEvent) => {
      e.stopPropagation();
      onExportToMarkdown?.();
    };

    const handleExportToImageClick = (e: MouseEvent) => {
      e.stopPropagation();
      onExportToImage?.();
    };

    const handleDuplicateTaskClick = (e: MouseEvent) => {
      e.stopPropagation();
      onDuplicateTask?.();
    };

    const handleArchiveTaskClick = (e: MouseEvent) => {
      e.stopPropagation();
      onArchiveTask?.();
    };

    const handleUnarchiveTaskClick = (e: MouseEvent) => {
      e.stopPropagation();
      onUnarchiveTask?.();
    };

    const handlePinClick = (e: MouseEvent) => {
      e.stopPropagation();
      onTogglePin?.();
    };

    const handleMoveToTopClick = (e: MouseEvent) => {
      e.stopPropagation();
      onMoveToTop?.();
    };

    const handleStateChange = (e: MouseEvent, state: string) => {
      e.stopPropagation();
      onChangeState?.(state);
    };

    const handleHighlightChange = (e: MouseEvent, color: string | null) => {
      e.stopPropagation();
      onHighlightChange?.(color);
    };

    return (
      <div className={clsx('relative flex items-center', isMenuOpen ? 'flex' : 'w-0 group-hover:w-auto')}>
        <div ref={buttonRef}>
          <button
            className={clsx(
              'transition-opacity p-1.5 rounded-md hover:bg-bg-tertiary text-text-muted hover:text-text-primary',
              !isMenuOpen && 'opacity-0 group-hover:opacity-100',
            )}
            onClick={(e) => {
              e.stopPropagation();
              handleMenuClick();
            }}
          >
            <FaEllipsisVertical className="w-4 h-4" />
            data-testid={`task-menu-trigger-${task.id}`}
          </button>
        </div>
        {isMenuOpen &&
          menuPosition &&
          createPortal(
            <div
              ref={menuRef}
              style={{
                position: 'fixed',
                top: `${menuPosition.top}px`,
                left: `${menuPosition.left}px`,
              }}
              className="w-[170px] bg-bg-secondary-light border border-border-default-dark rounded shadow-lg z-[9999]"
            >
              <ul className="display-none group-hover:display-block">
                <li
                  className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                  onClick={handleEditClick}
                >
                  <HiOutlinePencil className="w-4 h-4" />
                  <span className="whitespace-nowrap">{t('taskSidebar.rename')}</span>
                </li>
                {onTogglePin && !isNewTask && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handlePinClick}
                  >
                    <MdPushPin className={clsx('w-4 h-4', isPinned && 'rotate-45')} />
                    <span className="whitespace-nowrap">{isPinned ? t('taskSidebar.unpinTask') : t('taskSidebar.pinTask')}</span>
                  </li>
                )}
                {onCopyAsMarkdown && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleCopyAsMarkdownClick}
                  >
                    <BiCopy className="w-4 h-4" />
                    <span className="whitespace-nowrap">{t('taskSidebar.copyAsMarkdown')}</span>
                  </li>
                )}
                {onExportToMarkdown && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleExportToMarkdownClick}
                  >
                    <IoLogoMarkdown className="w-4 h-4" />
                    <span className="whitespace-nowrap">{t('taskSidebar.exportAsMarkdown')}</span>
                  </li>
                )}
                {onExportToImage && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleExportToImageClick}
                  >
                    <MdImage className="w-4 h-4" />
                    <span className="whitespace-nowrap">{t('taskSidebar.exportAsImage')}</span>
                  </li>
                )}
                {onDuplicateTask && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleDuplicateTaskClick}
                  >
                    <BiDuplicate className="w-4 h-4" />
                    <span className="whitespace-nowrap">{t('taskSidebar.duplicateTask')}</span>
                  </li>
                )}
                {task.state !== DefaultTaskState.InProgress && !isNewTask && (
                  <>
                    <li className="px-2 pt-2 pb-0.5 text-3xs uppercase text-text-muted">
                      {t('taskSidebar.changeState')}
                    </li>
                    {[
                      DefaultTaskState.Todo,
                      DefaultTaskState.ReadyForImplementation,
                      DefaultTaskState.ReadyForReview,
                      DefaultTaskState.MoreInfoNeeded,
                      DefaultTaskState.Done,
                    ].map((state) => (
                      <li
                        key={state}
                        className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                        onClick={(e) => handleStateChange(e, state)}
                      >
                        {getTaskStateLabel(t, state)}
                      </li>
                    ))}
                  </>
                )}
                {onHighlightChange && (
                  <>
                    <li className="px-2 pt-2 pb-0.5 text-3xs uppercase text-text-muted">
                      {t('taskSidebar.highlightTask')}
                    </li>
                    <li className="grid grid-cols-7 h-7">
                      <button
                        className="flex items-center justify-center hover:bg-bg-tertiary transition-colors"
                        onClick={(e) => handleHighlightChange(e, null)}
                      >
                        <MdClose className="w-4 h-4" />
                      </button>
                      {TASK_HIGHLIGHT_COLORS.map((color) => {
                        const currentHighlight = typeof task.metadata?.highlightColor === 'string' ? task.metadata.highlightColor : undefined;
                        const isActive = currentHighlight === color;
                        return (
                          <button
                            key={color}
                            data-testid={`task-highlight-color-${color}`}
                            className="relative flex items-center justify-center hover:bg-bg-tertiary transition-colors"
                            onClick={(e) => handleHighlightChange(e, color)}
                          >
                            <span className="w-3.5 h-3.5 rounded-full border border-border-default-dark" style={{ backgroundColor: color }} />
                            {isActive && <HiCheck className="absolute w-3 h-3 text-text-primary" />}
                          </button>
                        );
                      })}
                    </li>
                  </>
                )}
                {onMoveToTop && !isNewTask && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleMoveToTopClick}
                  >
                    <MdVerticalAlignTop className="w-4 h-4" />
                    <span className="whitespace-nowrap">{t('taskSidebar.moveToTop')}</span>
                  </li>
                )}
                {onArchiveTask && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleArchiveTaskClick}
                  >
                    <BiArchive className="w-4 h-4" />
                    <span className="whitespace-nowrap">{t('taskSidebar.archiveTask')}</span>
                  </li>
                )}
                {onUnarchiveTask && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleUnarchiveTaskClick}
                  >
                    <BiArchiveIn className="w-4 h-4" />
                    <span className="whitespace-nowrap">{t('taskSidebar.unarchiveTask')}</span>
                  </li>
                )}
                {onDelete && (
                  <li
                    className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={handleDeleteClick}
                  >
                    <HiOutlineTrash className="w-4 h-4 text-error" />
                    <span className="whitespace-nowrap">{t('taskSidebar.deleteTask')}</span>
                  </li>
                )}
              </ul>
            </div>,
            document.body,
          )}

      </div>
    );
  },
);

TaskMenuButton.displayName = 'TaskMenuButton';
