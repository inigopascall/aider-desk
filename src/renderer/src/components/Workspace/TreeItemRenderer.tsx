import { ContextFile, OS, TokensCost, UpdatedFile } from '@common/types';
import { useCallback, useMemo } from 'react';
import { HiChevronDown, HiChevronRight, HiPlus, HiX } from 'react-icons/hi';
import { MdUndo, MdOutlinePublic, MdOutlineMap } from 'react-icons/md';
import { TbPencilOff } from 'react-icons/tb';
import { RiAlertLine, RiRobot2Line } from 'react-icons/ri';
import { VscFileCode } from 'react-icons/vsc';
import { useTranslation } from 'react-i18next';
import { twMerge } from 'tailwind-merge';

import { normalizePath } from './types';

import type { SectionType, TreeItem } from './types';

import { Tooltip } from '@/components/ui/Tooltip';
import { TriState, TriStateCheckbox } from '@/components/common/TriStateCheckbox';

// Fixed-width control slots shared with the mapping/rule flat lists: a 16px
// icon area, a 16px checkbox slot, and a 24px trailing delete slot, separated
// by 4px gaps (gap-1) with a 4px right inset (pr-1 on the row). Reserving the
// slots keeps the checkbox/delete columns aligned whether or not optional
// leading icons (e.g. read-only) are present.
const ICON_SLOT_CLASS = 'w-4 h-4 flex items-center justify-center flex-shrink-0';
const CHECKBOX_SLOT_CLASS = 'w-4 h-4 flex items-center justify-center flex-shrink-0';
const DELETE_SLOT_CLASS = 'w-6 h-6 flex-shrink-0';

const getDescendantFiles = (treeData: Record<string, TreeItem>, nodeId: string | number): ContextFile[] => {
  const node = treeData[String(nodeId)];
  if (!node?.children) {
    return [];
  }
  const result: ContextFile[] = [];
  for (const childId of node.children) {
    const child = treeData[String(childId)];
    if (!child) {
      continue;
    }
    if (child.isFolder) {
      result.push(...getDescendantFiles(treeData, childId));
    } else if (child.file?.path) {
      result.push(child.file);
    }
  }
  return result;
};

type Props = {
  item: TreeItem;
  title: React.ReactNode;
  children: React.ReactNode;
  type: SectionType;
  treeData: Record<string, TreeItem>;
  expandedItems: string[];
  setExpandedItems: (items: string[]) => void;
  contextFilesMap: Map<string, ContextFile>;
  updatedFiles: UpdatedFile[];
  fileTokensInfo?: Record<string, TokensCost> | null;
  os: OS | null;
  disabledRuleFiles?: string[];
  onToggleRuleFile?: (filePaths: string[], disabled: boolean) => void;
  onToggleContextFiles?: (filePaths: string[], disabled: boolean, shiftKey: boolean) => void;
  onFileDiffClick: (file: UpdatedFile) => void;
  onFilePreviewClick?: (filePath: string) => void;
  onAddFileToGit?: (filePath: string) => void;
  addingFilesToGit?: Set<string>;
  onRevertFile: (filePath: string) => void;
  onDropFile: (item: TreeItem) => (e: React.MouseEvent<HTMLButtonElement>) => void;
  onAddFile: (item: TreeItem) => (event: React.MouseEvent<HTMLButtonElement>) => void;
};

export const TreeItemRenderer = ({
  item,
  title,
  children,
  type,
  treeData,
  expandedItems,
  setExpandedItems,
  contextFilesMap,
  updatedFiles,
  fileTokensInfo,
  disabledRuleFiles,
  onToggleRuleFile,
  onToggleContextFiles,
  onFileDiffClick,
  onFilePreviewClick,
  onAddFileToGit,
  addingFilesToGit,
  onRevertFile,
  onDropFile,
  onAddFile,
}: Props) => {
  const { t } = useTranslation();

  const source = item.file?.source;
  const isRuleFile = source === 'global-rule' || source === 'project-rule' || source === 'agent-rule';
  const filePath = item.file?.path;
  const isContextFile = filePath ? contextFilesMap.has(normalizePath(filePath)) : false;
  const showRuleCheckbox = type === 'rules' && isRuleFile && !item.isFolder && onToggleRuleFile;
  const isRuleDisabled = isRuleFile && filePath ? (disabledRuleFiles ?? []).includes(filePath) : false;
  const showFolderCheckbox = type === 'rules' && item.isFolder && onToggleRuleFile;
  const showContextCheckbox = type === 'context' && !item.isFolder && !!onToggleContextFiles;
  const showContextFolderCheckbox = type === 'context' && item.isFolder && !!onToggleContextFiles;
  const useAlignedControlSlots = type === 'context' || type === 'rules';

  const descendantFiles = useMemo(() => getDescendantFiles(treeData, item.index), [treeData, item.index]);
  const folderRuleFiles = descendantFiles.filter((file) => file.source === 'global-rule' || file.source === 'project-rule' || file.source === 'agent-rule').map((file) => file.path);
  const folderContextFiles = descendantFiles.filter((file) => contextFilesMap.has(normalizePath(file.path)));

  const folderCheckState = useMemo((): TriState => {
    const files = showFolderCheckbox ? folderRuleFiles.map((path) => ({ path, disabled: (disabledRuleFiles ?? []).includes(path) })) : folderContextFiles;
    if (files.length === 0) return 'unchecked';
    const enabledCount = files.filter((file) => !file.disabled).length;
    return enabledCount === 0 ? 'unchecked' : enabledCount === files.length ? 'checked' : 'indeterminate';
  }, [showFolderCheckbox, folderRuleFiles, folderContextFiles, disabledRuleFiles]);

  const handleFileCheckboxToggle = useCallback((shiftKey = false) => {
    if (filePath && onToggleRuleFile) onToggleRuleFile([filePath], !isRuleDisabled);
    else if (filePath && onToggleContextFiles) {
      const file = contextFilesMap.get(normalizePath(filePath)) ?? item.file;
      onToggleContextFiles([filePath], !file?.disabled, shiftKey);
    }
  }, [filePath, onToggleRuleFile, onToggleContextFiles, isRuleDisabled, contextFilesMap, item.file]);

  const handleFolderCheckboxToggle = useCallback(() => {
    if (showFolderCheckbox && folderRuleFiles.length > 0) onToggleRuleFile?.(folderRuleFiles, folderCheckState === 'checked');
    else if (showContextFolderCheckbox && folderContextFiles.length > 0) onToggleContextFiles?.(folderContextFiles.map((file) => file.path), folderCheckState === 'checked', false);
  }, [showFolderCheckbox, folderRuleFiles, folderCheckState, onToggleRuleFile, showContextFolderCheckbox, folderContextFiles, onToggleContextFiles]);

  const updatedFile = type === 'updated' ? updatedFiles.find((f) => normalizePath(f.path) === normalizePath(item.file?.path || '')) : undefined;

  const showAdd = type === 'project' && !isContextFile && !isRuleFile;
  const showRemove = (type === 'context' || (type === 'project' && isContextFile)) && !isRuleFile;
  const showAddToGit = type === 'updated' && updatedFile?.isUntracked && !item.isFolder && !updatedFile.commitHash && onAddFileToGit;
  const showRevert = type === 'updated' && updatedFile && !item.isFolder && !updatedFile.commitHash && !updatedFile.isUntracked;
  const showConflictWarning = type === 'updated' && updatedFile?.hasConflicts && !item.isFolder;
  const isAddingToGit = updatedFile ? addingFilesToGit?.has(updatedFile.path) : false;

  const fileTokenInfo = fileTokensInfo?.[item.index];
  const fileTokenTooltip = fileTokenInfo ? `${fileTokenInfo.tokens || 0} ${t('usageDashboard.charts.tokens')}, $${(fileTokenInfo.cost || 0).toFixed(5)}` : '';

  const toggleFolder = useCallback(() => {
    const isExpanded = expandedItems.includes(String(item.index));
    if (isExpanded) {
      setExpandedItems(expandedItems.filter((id) => id !== String(item.index)));
    } else {
      setExpandedItems([...expandedItems, String(item.index)]);
    }
  }, [expandedItems, item.index, setExpandedItems]);

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleFolder();
    },
    [toggleFolder],
  );

  const handleTitleClick = useCallback(() => {
    if (item.isFolder) {
      toggleFolder();
    } else if (!item.isFolder && filePath && (type === 'project' || type === 'context') && onFilePreviewClick) {
      onFilePreviewClick(filePath);
    }
  }, [item.isFolder, toggleFolder, type, filePath, onFilePreviewClick]);

  const handleUpdatedFileClick = useCallback(() => {
    if (updatedFile) {
      onFileDiffClick(updatedFile);
    }
  }, [updatedFile, onFileDiffClick]);

  const handleAddToGitClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (updatedFile && onAddFileToGit) {
        onAddFileToGit(updatedFile.path);
      }
    },
    [updatedFile, onAddFileToGit],
  );

  const handleRevertClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (updatedFile) {
        onRevertFile(updatedFile.path);
      }
    },
    [updatedFile, onRevertFile],
  );

  const renderChevron = () => {
    if (!item.isFolder) {
      return <span className="w-3 h-3 inline-block" />;
    }
    return (
      <span className="flex items-center justify-center cursor-pointer" onClick={handleChevronClick}>
        {expandedItems.includes(String(item.index)) ? (
          <HiChevronDown className="w-3 h-3 text-text-muted-dark" />
        ) : (
          <HiChevronRight className="w-3 h-3 text-text-muted-dark" />
        )}
      </span>
    );
  };

  const renderTitle = () => {
    const className = twMerge(
      'select-none text-2xs overflow-hidden whitespace-nowrap overflow-ellipsis',
      item.isFolder || (type === 'context' && item.file?.disabled)
        ? 'context-dimmed'
        : type === 'updated' && updatedFile?.isUntracked
          ? 'text-text-muted-light'
          : type === 'project' && !isContextFile
            ? 'context-dimmed'
            : 'text-text-primary',
      type === 'updated' && !item.isFolder && 'cursor-pointer hover:text-text-tertiary',
    );

    const renderFile = () => {
      if (updatedFile && !item.isFolder) {
        return (
          <div className="flex items-center gap-2 min-w-0 cursor-pointer hover:text-text-tertiary" onClick={handleUpdatedFileClick}>
            <span className={className}>{title}</span>
            <span className="text-4xs text-text-muted-dark flex-shrink-0 flex items-center gap-0.5 mt-0.5">
              {updatedFile.additions > 0 && <span className="text-success">+{updatedFile.additions}</span>}
              {updatedFile.deletions > 0 && <span className="text-error">-{updatedFile.deletions}</span>}
            </span>
          </div>
        );
      }

      if ((type === 'project' || type === 'context') && !item.isFolder && filePath) {
        return (
          <span className={twMerge(className, 'cursor-pointer hover:text-text-tertiary')} onClick={handleTitleClick}>
            {title}
          </span>
        );
      }

      if (item.isFolder) {
        return (
          <span className={twMerge(className, 'cursor-pointer')} onClick={handleTitleClick}>
            {title}
          </span>
        );
      }

      return <span className={className}>{title}</span>;
    };

    if (fileTokenTooltip) {
      return <Tooltip content={fileTokenTooltip}>{renderFile()}</Tooltip>;
    }
    return renderFile();
  };

  const leadingIcons = (
    <>
      {isRuleFile && (
        <>
          {source === 'global-rule' && (
            <Tooltip content={t('contextFiles.globalRule')}>
              <MdOutlinePublic className="w-4 h-4 text-text-muted-light" />
            </Tooltip>
          )}
          {source === 'project-rule' && (
            <Tooltip content={t('contextFiles.projectRule')}>
              <VscFileCode className="w-4 h-4 text-text-muted-light" />
            </Tooltip>
          )}
          {source === 'agent-rule' && (
            <Tooltip content={t('contextFiles.agentRule')}>
              <RiRobot2Line className="w-4 h-4 text-text-muted-light" />
            </Tooltip>
          )}
        </>
      )}
      {source === 'repo-mapping' && (
        <Tooltip content={t('contextFiles.repositoryMappingFile')}>
          <MdOutlineMap className="w-4 h-4 text-text-muted-light" />
        </Tooltip>
      )}
      {showConflictWarning && (
        <Tooltip content={t('contextFiles.fileHasConflicts')}>
          <RiAlertLine className="w-4 h-4 text-warning" />
        </Tooltip>
      )}
      {item.file?.readOnly && !isRuleFile && (
        <Tooltip content={t('contextFiles.readOnly')}>
          <TbPencilOff className="w-4 h-4 text-text-muted-light" />
        </Tooltip>
      )}
    </>
  );

  const checkboxControls = (
    <>
      {showFolderCheckbox && folderRuleFiles.length > 0 && <TriStateCheckbox state={folderCheckState} onChange={handleFolderCheckboxToggle} />}
      {showContextFolderCheckbox && folderContextFiles.length > 0 && <TriStateCheckbox state={folderCheckState} onChange={handleFolderCheckboxToggle} />}
      {showRuleCheckbox && <TriStateCheckbox state={isRuleDisabled ? 'unchecked' : 'checked'} onChange={handleFileCheckboxToggle} />}
      {showContextCheckbox && <TriStateCheckbox state={item.file?.disabled ? 'unchecked' : 'checked'} onChange={handleFileCheckboxToggle} />}
    </>
  );

  const removeControl = showRemove ? (
    <button onClick={onDropFile(item)} className="px-1 py-1 rounded hover:bg-bg-primary-light text-text-muted hover:text-error-dark">
      <HiX className="w-4 h-4" />
    </button>
  ) : null;

  return (
    <>
      <div className="flex space-between items-center w-full pr-1 h-6 group/item">
        <div className="flex items-center flex-grow min-w-0">
          {renderChevron()}
          {renderTitle()}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0 group">
          {useAlignedControlSlots ? (
            <>
              <span className={ICON_SLOT_CLASS}>{leadingIcons}</span>
              <span className={CHECKBOX_SLOT_CLASS}>{checkboxControls}</span>
              {removeControl ?? <span className={DELETE_SLOT_CLASS} aria-hidden="true" />}
            </>
          ) : (
            <>
              {leadingIcons}
              {checkboxControls}
              {removeControl}
            </>
          )}
          {showAdd && (
            <Tooltip content={t('contextFiles.addFileTooltip.cmd')}>
              <button onClick={onAddFile(item)} className="px-1 py-1 rounded hover:bg-bg-primary-light text-text-muted hover:text-text-primary">
                <HiPlus className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
          {showAddToGit && (
            <Tooltip content={t('contextFiles.addFileToGit')}>
              <button
                onClick={handleAddToGitClick}
                disabled={isAddingToGit}
                className="px-1 py-1 rounded hover:bg-bg-primary-light text-text-muted-light hover:text-text-primary disabled:opacity-50"
              >
                <HiPlus className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
          {showRevert && (
            <Tooltip content={t('contextFiles.revertFile')}>
              <button onClick={handleRevertClick} className="px-1 py-1 rounded hover:bg-bg-primary-light text-text-muted hover:text-text-primary">
                <MdUndo className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {children}
    </>
  );
};
