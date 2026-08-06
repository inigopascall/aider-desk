import { ContextFile, Mode, OS, TokensCost } from '@common/types';
import { compareBaseDirs } from '@common/utils';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { HiOutlineTrash, HiPlus } from 'react-icons/hi';
import { BiCopy, BiPaste } from 'react-icons/bi';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

import { WorkspaceSection } from './WorkspaceSection';
import { EmptyContextInfo } from './EmptyContextInfo';
import { FileViewerModal } from './FileViewerModal';
import { createFileTree } from './types';

import type { TreeItem } from './types';

import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { useContextFilesClipboard, useHasCopiedFiles } from '@/stores/contextFilesClipboardStore';

type Props = {
  mode: Mode;
  baseDir: string;
  taskId: string;
  userContextFiles: ContextFile[];
  isOpen: boolean;
  totalStats: { additions: number; deletions: number };
  fileTokensInfo?: Record<string, TokensCost> | null;
  os: OS | null;
  contextFilesMap: Map<string, ContextFile>;
  showFileDialog: () => void;
  onDropAllFiles: () => void;
  onToggle: () => void;
  onFilePreviewClick?: (filePath: string) => void;
  onDropFile: (item: TreeItem) => (e: React.MouseEvent<HTMLButtonElement>) => void;
  editMode?: boolean;
  isHidden?: boolean;
  onToggleHidden?: () => void;
  showBorderTop?: boolean;
};

export const ContextFilesSection = ({
  mode,
  baseDir,
  taskId,
  userContextFiles,
  isOpen,
  totalStats,
  fileTokensInfo,
  os,
  contextFilesMap,
  showFileDialog,
  onDropAllFiles,
  onToggle,
  onFilePreviewClick,
  onDropFile,
  editMode,
  isHidden,
  onToggleHidden,
  showBorderTop,
}: Props) => {
  const { t } = useTranslation();

  const api = useApi();
  const hasCopiedFiles = useHasCopiedFiles();
  const copyToClipboard = useContextFilesClipboard((s) => s.copy);

  const [contextExpandedItems, setContextExpandedItems] = useState<string[]>([]);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const sortedUserFiles = useMemo(() => {
    return [...userContextFiles].sort((a, b) => a.path.localeCompare(b.path));
  }, [userContextFiles]);

  const contextTreeData = useMemo(() => {
    return createFileTree(sortedUserFiles, 'root');
  }, [sortedUserFiles]);

  useEffect(() => {
    const expandFolders = (treeData: Record<string, TreeItem>, files: ContextFile[]) => {
      const foldersToExpand = Object.keys(treeData).filter((key) => {
        const node = treeData[key];
        if (!node.isFolder) {
          return false;
        }

        const checkChild = (childKey: string | number) => {
          const childNode = treeData[String(childKey)];
          if (!childNode) {
            return false;
          }
          if (!childNode.isFolder) {
            return files.some((f) => f.path === (childNode.file?.path || ''));
          }
          return childNode.children?.some(checkChild) || false;
        };
        return node.children?.some(checkChild) || false;
      });

      setContextExpandedItems((prevState) => Array.from(new Set([...prevState, ...foldersToExpand])));
    };

    expandFolders(contextTreeData, userContextFiles);
  }, [contextTreeData, userContextFiles]);

  const addFile = useCallback((_item: TreeItem) => (_event: React.MouseEvent<HTMLButtonElement>) => {}, []);

  const handleCopy = useCallback(() => {
    // userContextFiles already excludes rule files (computed in Workspace.tsx),
    // so rules are intentionally not carried across tasks/projects.
    copyToClipboard(userContextFiles, baseDir);
  }, [copyToClipboard, userContextFiles, baseDir]);

  const handlePaste = useCallback(async () => {
    const clipboardState = useContextFilesClipboard.getState();
    console.log('Paste handler entered', clipboardState);

    if (!clipboardState.sourceBaseDir || clipboardState.copiedFiles.length === 0) {
      console.warn('Paste aborted by clipboard guard', clipboardState);
      return;
    }

    const isSameProject = compareBaseDirs(clipboardState.sourceBaseDir, baseDir);
    // Project roots are stored without a trailing separator, but strip defensively
    // to avoid producing a double separator when joining relative paths.
    const sourceRoot = clipboardState.sourceBaseDir.replace(/[/\\]+$/, '');

    const jobs = clipboardState.copiedFiles.map(async (file) => {
      if (isSameProject) {
        // Same project/Paths are already relative to the project root (or already
        // absolute for external read-only files). Preserve the original readOnly flag.
        const pathToAdd = file.path;
        const readOnly = file.readOnly;
        console.log('Pasting context file', { file, pathToAdd, readOnly, isSameProject });
        await api.addFile(baseDir, taskId, pathToAdd, readOnly);
      } else {
        // Different project: convert relative paths to absolute, force readOnly.
        // If the path is already absolute (e.g. a file from outside the source
        // project), use it as-is.
        const isAbsolute = file.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file.path);
        const absolutePath = isAbsolute ? file.path : `${sourceRoot}/${file.path}`;
        const readOnly = true;
        console.log('Pasting context file', { file, pathToAdd: absolutePath, readOnly, isSameProject });
        await api.addFile(baseDir, taskId, absolutePath, readOnly);
      }
    });

    await Promise.all(jobs);
  }, [api, baseDir, taskId]);

  const contextActions = useMemo(
    () => (
      <>
        <Tooltip content={t('contextFiles.dropAll')}>
          <button
            onClick={onDropAllFiles}
            className="p-1.5 hover:bg-bg-tertiary rounded-md text-text-muted hover:text-error transition-colors disabled:opacity-50"
            disabled={userContextFiles.length === 0}
          >
            <HiOutlineTrash className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('contextFiles.copyContextFiles')}>
          <button
            onClick={handleCopy}
            className="p-1.5 hover:bg-bg-tertiary rounded-md text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
            disabled={userContextFiles.length === 0}
          >
            <BiCopy className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('contextFiles.pasteContextFiles')}>
          <button
            onClick={handlePaste}
            className={clsx(
              'p-1.5 hover:bg-bg-tertiary rounded-md transition-colors disabled:opacity-50',
              hasCopiedFiles
                ? 'text-accent-primary hover:text-accent-primary'
                : 'text-text-muted hover:text-text-primary',
            )}
            disabled={!hasCopiedFiles}
          >
            <BiPaste className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('contextFiles.add')}>
          <button onClick={showFileDialog} className="p-1 hover:bg-bg-tertiary rounded-md text-text-muted hover:text-text-primary transition-colors">
            <HiPlus className="w-5 h-5" />
          </button>
        </Tooltip>
      </>
    ),
    [t, onDropAllFiles, userContextFiles.length, showFileDialog, handleCopy, handlePaste, hasCopiedFiles],
  );

  return (
    <>
      <WorkspaceSection
        section="context"
        title={t('contextFiles.title')}
        count={userContextFiles.length}
        isOpen={isOpen}
        totalStats={totalStats}
        treeData={contextTreeData}
        expandedItems={contextExpandedItems}
        setExpandedItems={setContextExpandedItems}
        contextFilesMap={contextFilesMap}
        updatedFiles={[]}
        fileTokensInfo={fileTokensInfo}
        os={os}
        actions={contextActions}
        emptyContent={<EmptyContextInfo mode={mode} />}
        onToggle={onToggle}
        onFileDiffClick={() => {}}
        onFilePreviewClick={(filePath: string) => {
          if (onFilePreviewClick) {
            onFilePreviewClick(filePath);
          } else {
            setPreviewFilePath(filePath);
          }
        }}
        onRevertFile={() => {}}
        onDropFile={onDropFile}
        onAddFile={addFile}
        editMode={editMode}
        isHidden={isHidden}
        onToggleHidden={onToggleHidden}
        showBorderTop={showBorderTop}
      />

      {previewFilePath && <FileViewerModal filePath={previewFilePath} baseDir={baseDir} taskId={taskId} onClose={() => setPreviewFilePath(null)} />}
    </>
  );
};
