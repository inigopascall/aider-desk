import { DefaultTaskState, TaskData } from '@common/types';
import { useTranslation } from 'react-i18next';
import { MouseEvent, useRef, useState, useEffect, memo } from 'react';
import { HiCheck, HiOutlinePencil, HiOutlineTrash } from 'react-icons/hi';
import { FaEllipsisVertical } from 'react-icons/fa6';
import { IoLogoMarkdown } from 'react-icons/io';
import { RiFlag2Line } from 'react-icons/ri';
import { MdClose, MdColorLens, MdImage, MdPushPin, MdChevronRight, MdVerticalAlignTop } from 'react-icons/md';
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
    const [isStateSubmenuOpen, setIsStateSubmenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
    const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLDivElement>(null);
    const stateSubmenuItemRef = useRef<HTMLLIElement>(null);
    const stateSubmenuRef = useRef<HTMLDivElement>(null);
    const [isHighlightSubmenuOpen, setIsHighlightSubmenuOpen] = useState(false);
    const [highlightSubmenuPosition, setHighlightSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
    const highlightSubmenuItemRef = useRef<HTMLLIElement>(null);
    const highlightSubmenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (isMenuOpen && buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setMenuPosition({
          top: rect.bottom + 4,
          left: rect.right - 170,
        });
      } else {
        setMenuPosition(null);
      }
    }, [isMenuOpen]);

    useEffect(() => {
      if (isStateSubmenuOpen && stateSubmenuItemRef.current) {
        const rect = stateSubmenuItemRef.current.getBoundingClientRect();
        setSubmenuPosition({
          top: rect.top,
          left: rect.right + 4,
        });
      } else {
        setSubmenuPosition(null);
      }
    }, [isStateSubmenuOpen]);

    useEffect(() => {
      if (isHighlightSubmenuOpen && highlightSubmenuItemRef.current) {
        const rect = highlightSubmenuItemRef.current.getBoundingClientRect();
        setHighlightSubmenuPosition({
          top: rect.top,
          left: rect.right + 4,
        });
      } else {
        setHighlightSubmenuPosition(null);
      }
    }, [isHighlightSubmenuOpen]);

    useEffect(() => {
      if (!isMenuOpen) {
        setIsStateSubmenuOpen(false);
        setIsHighlightSubmenuOpen(false);
      }
    }, [isMenuOpen]);

    useClickOutside(
      [menuRef, buttonRef, stateSubmenuRef, highlightSubmenuRef],
      () => {
        setIsMenuOpen(false);
        setIsStateSubmenuOpen(false);
        setIsHighlightSubmenuOpen(false);
      },
      isMenuOpen,
    );

    const handleMenuClick = () => {
      setIsMenuOpen(!isMenuOpen);
    };

    const handleEditClick = (e: MouseEvent) => {
      e.stopPropagation();
      onEdit();
      setIsMenuOpen(false);
    };

    const handleDeleteClick = (e: MouseEvent) => {
      e.stopPropagation();
      onDelete?.();
      setIsMenuOpen(false);
    };

    const handleCopyAsMarkdownClick = (e: MouseEvent) => {
      e.stopPropagation();
      onCopyAsMarkdown?.();
      setIsMenuOpen(false);
    };

    const handleExportToMarkdownClick = (e: MouseEvent) => {
      e.stopPropagation();
      onExportToMarkdown?.();
      setIsMenuOpen(false);
    };

    const handleExportToImageClick = (e: MouseEvent) => {
      e.stopPropagation();
      onExportToImage?.();
      setIsMenuOpen(false);
    };

    const handleDuplicateTaskClick = (e: MouseEvent) => {
      e.stopPropagation();
      onDuplicateTask?.();
      setIsMenuOpen(false);
    };

    const handleArchiveTaskClick = (e: MouseEvent) => {
      e.stopPropagation();
      onArchiveTask?.();
      setIsMenuOpen(false);
    };

    const handleUnarchiveTaskClick = (e: MouseEvent) => {
      e.stopPropagation();
      onUnarchiveTask?.();
      setIsMenuOpen(false);
    };

    const handlePinClick = (e: MouseEvent) => {
      e.stopPropagation();
      onTogglePin?.();
    };

    const handleMoveToTopClick = (e: MouseEvent) => {
      e.stopPropagation();
      onMoveToTop?.();
      setIsMenuOpen(false);
    };

    const handleStateSubmenuToggle = () => {
      setIsStateSubmenuOpen(!isStateSubmenuOpen);
    };

    const handleStateChange = (e: MouseEvent, state: string) => {
      e.stopPropagation();
      onChangeState?.(state);
      setIsStateSubmenuOpen(false);
      setIsMenuOpen(false);
    };

    const handleHighlightSubmenuToggle = () => {
      setIsHighlightSubmenuOpen(!isHighlightSubmenuOpen);
    };

    const handleHighlightChange = (e: MouseEvent, color: string | null) => {
      e.stopPropagation();
      onHighlightChange?.(color);
      setIsHighlightSubmenuOpen(false);
      setIsMenuOpen(false);
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
                  <li
                    ref={stateSubmenuItemRef}
                    className="relative flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStateSubmenuToggle();
                    }}
                  >
                    <RiFlag2Line className="w-4 h-4" />
                    <span className="whitespace-nowrap flex-1">{t('taskSidebar.changeState')}</span>
                    <MdChevronRight className="w-3.5 h-3.5 text-text-muted" />
                  </li>
                )}
                {onHighlightChange && (
                  <li
                    ref={highlightSubmenuItemRef}
                    className="relative flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleHighlightSubmenuToggle();
                    }}
                  >
                    <MdColorLens className="w-4 h-4" />
                    <span className="whitespace-nowrap flex-1">{t('taskSidebar.highlightTask')}</span>
                    <MdChevronRight className="w-3.5 h-3.5 text-text-muted" />
                  </li>
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
        {isStateSubmenuOpen &&
          submenuPosition &&
          createPortal(
            <div
              ref={stateSubmenuRef}
              style={{
                position: 'fixed',
                top: `${submenuPosition.top}px`,
                left: `${submenuPosition.left}px`,
              }}
              className="w-[180px] bg-bg-secondary-light border border-border-default-dark rounded shadow-lg z-[9999]"
              onClick={(e) => e.stopPropagation()}
            >
              <ul className="py-1">
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
              </ul>
            </div>,
            document.body,
          )}
        {isHighlightSubmenuOpen &&
          highlightSubmenuPosition &&
          createPortal(
            <div
              ref={highlightSubmenuRef}
              style={{
                position: 'fixed',
                top: `${highlightSubmenuPosition.top}px`,
                left: `${highlightSubmenuPosition.left}px`,
              }}
              className="w-[180px] bg-bg-secondary-light border border-border-default-dark rounded shadow-lg z-[9999]"
              onClick={(e) => e.stopPropagation()}
            >
              <ul className="py-1">
                {TASK_HIGHLIGHT_COLORS.map((color) => {
                  const currentHighlight = typeof task.metadata?.highlightColor === 'string' ? task.metadata.highlightColor : undefined;
                  const isActive = currentHighlight === color;
                  return (
                    <li
                      key={color}
                      className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                      onClick={(e) => handleHighlightChange(e, color)}
                    >
                      <span className="w-4 h-4 rounded-full border border-border-default-dark" style={{ backgroundColor: color }} />
                      <span className="uppercase">{color}</span>
                      {isActive && <HiCheck className="w-4 h-4 ml-auto" />}
                    </li>
                  );
                })}
                {task.metadata?.highlightColor && (
                  <>
                    <li className="px-2 py-1"><div className="border-t border-border-default-dark" /></li>
                    <li
                      className="flex items-center gap-2 px-2 py-1 text-2xs text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
                      onClick={(e) => handleHighlightChange(e, null)}
                    >
                      <MdClose className="w-4 h-4" />
                      <span className="whitespace-nowrap">{t('taskSidebar.removeHighlight')}</span>
                    </li>
                  </>
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
