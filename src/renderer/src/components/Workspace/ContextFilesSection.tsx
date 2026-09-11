import { ContextFile, Mode, OS, TokensCost } from '@common/types';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HiOutlineTrash, HiPlus } from 'react-icons/hi';
import { BiCopy, BiPaste } from 'react-icons/bi';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

import { WorkspaceSection } from './WorkspaceSection';
import { EmptyContextInfo } from './EmptyContextInfo';
import { FileViewerModal } from './FileViewerModal';
import { collectVisibleFilePaths, createFileTree, normalizePath } from './types';

import type { TreeItem } from './types';

import { Tooltip } from '@/components/ui/Tooltip';
import { useShiftRangeSelection } from '@/hooks/useShiftRangeSelection';
import { useApi } from '@/contexts/ApiContext';
import { useContextFilesClipboard, useHasCopiedFiles } from '@/stores/contextFilesClipboardStore';
import { useTaskStore } from '@/stores/taskStore';
import { showErrorNotification } from '@/utils/notifications';

// A single pending optimistic toggle for one context file path. `opId` is the
// operation that owns this entry so an older request/event cannot revert a
// newer pending selection.
type PendingToggle = {
  disabled: boolean;
  opId: number;
};

const areSameProject = (first: string, second: string): boolean => {
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.length === 0 ? '/' : normalized;
  };

  const a = normalize(first);
  const b = normalize(second);

  // Windows paths are case-insensitive
  if (/^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }

  return a === b;
};

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

  // Pending optimistic toggles, scoped to this baseDir/taskId instance. The
  // authoritative store is never mutated optimistically; instead we overlay
  // these pending entries on top of the authoritative context files so the
  // tree, context map, enabled count and folder aggregates all share the same
  // effective state.
  const [pendingMap, setPendingMapState] = useState<Map<string, PendingToggle>>(new Map());
  const pendingMapRef = useRef<Map<string, PendingToggle>>(new Map());
  const opIdRef = useRef(0);
  const scopeRef = useRef<string>(`${baseDir}\u0000${taskId}`);
  scopeRef.current = `${baseDir}\u0000${taskId}`;

  const setPendingMap = useCallback((updater: (prev: Map<string, PendingToggle>) => Map<string, PendingToggle>) => {
    setPendingMapState((prev) => {
      const next = updater(prev);
      pendingMapRef.current = next;
      return next;
    });
  }, []);

  // Reset pending bookkeeping whenever the scope changes so completions from a
  // previous baseDir/taskId can never modify the current scope.
  useEffect(() => {
    setPendingMap(new Map());
    opIdRef.current = 0;
  }, [baseDir, taskId, setPendingMap]);

  const effectiveUserContextFiles = useMemo(() => {
    if (pendingMap.size === 0) return userContextFiles;
    return userContextFiles.map((file) => {
      const pending = pendingMap.get(normalizePath(file.path));
      return pending ? { ...file, disabled: pending.disabled } : file;
    });
  }, [userContextFiles, pendingMap]);

  const effectiveContextFilesMap = useMemo(() => {
    if (pendingMap.size === 0) return contextFilesMap;
    const map = new Map(contextFilesMap);
    for (const [path, pending] of pendingMap) {
      const existing = map.get(path);
      if (existing) {
        map.set(path, { ...existing, disabled: pending.disabled });
      }
    }
    return map;
  }, [contextFilesMap, pendingMap]);

  const sortedUserFiles = useMemo(() => {
    return [...effectiveUserContextFiles].sort((a, b) => a.path.localeCompare(b.path));
  }, [effectiveUserContextFiles]);

  const contextTreeData = useMemo(() => {
    return createFileTree(sortedUserFiles, 'root');
  }, [sortedUserFiles]);

  const visibleFilePaths = useMemo(
    () => collectVisibleFilePaths(contextTreeData, contextExpandedItems),
    [contextTreeData, contextExpandedItems],
  );
  const { resolveRange } = useShiftRangeSelection(visibleFilePaths);
  const enabledFileCount = useMemo(
    () => effectiveUserContextFiles.filter((file) => !file.disabled).length,
    [effectiveUserContextFiles],
  );

  const handleToggleContextFiles = useCallback(
    (filePaths: string[], disabled: boolean, shiftKey: boolean) => {
      if (filePaths.length === 0) return;
      const paths = filePaths.length === 1 ? resolveRange(filePaths[0], shiftKey) : filePaths;
      const scope = `${baseDir}\u0000${taskId}`;
      const opId = ++opIdRef.current;

      // Record the optimistic intent for every affected path. The authoritative
      // store is left untouched; rendering overlays these pending entries.
      setPendingMap((prev) => {
        const next = new Map(prev);
        for (const path of paths) {
          next.set(normalizePath(path), { disabled, opId });
        }
        return next;
      });

      void api.setContextFilesDisabled(baseDir, taskId, paths, disabled).then(
        () => {
          if (scopeRef.current !== scope) return;
          // Success: keep the optimistic overlay until the authoritative event
          // reflects the change (the reconciliation effect clears it). If the
          // store has not caught up yet, request a fresh authoritative snapshot
          // so we never leave a permanent optimistic override.
          const currentFiles = useTaskStore.getState().taskStateMap.get(taskId)?.contextFiles ?? [];
          const stillPending = paths.some((path) => {
            const norm = normalizePath(path);
            const pending = pendingMapRef.current.get(norm);
            if (!pending || pending.opId !== opId) return false;
            const authoritative = currentFiles.find((f) => normalizePath(f.path) === norm);
            return !authoritative || authoritative.disabled !== pending.disabled;
          });
          if (stillPending) {
            void api.refreshContextFiles(baseDir, taskId).catch(() => {});
          }
        },
        (error) => {
          if (scopeRef.current !== scope) return;
          // Failure: for paths still owned by this operation, drop the
          // optimistic overlay so the authoritative (prior) state is shown.
          // Newer operations on the same path are left untouched, and unrelated
          // files/additions/removals are preserved.
          setPendingMap((prev) => {
            const next = new Map(prev);
            let changed = false;
            for (const path of paths) {
              const norm = normalizePath(path);
              const pending = next.get(norm);
              if (pending && pending.opId === opId) {
                next.delete(norm);
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          showErrorNotification(error instanceof Error ? error.message : String(error));
        },
      );
    },
    [api, baseDir, taskId, resolveRange, setPendingMap],
  );

  // Reconcile the pending overlay with authoritative state: once the store
  // reflects a pending disabled value (or the file no longer exists), drop the
  // overlay entry so no permanent optimistic override remains.
  useEffect(() => {
    setPendingMap((prev) => {
      if (prev.size === 0) return prev;
      const currentFiles = useTaskStore.getState().taskStateMap.get(taskId)?.contextFiles ?? [];
      const next = new Map(prev);
      let changed = false;
      for (const [path, pending] of prev) {
        const authoritative = currentFiles.find((f) => normalizePath(f.path) === path);
        if (!authoritative || authoritative.disabled === pending.disabled) {
          next.delete(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [userContextFiles, taskId, setPendingMap]);

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

    expandFolders(contextTreeData, effectiveUserContextFiles);
  }, [contextTreeData, effectiveUserContextFiles]);

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

    try {
      const isSameProject = areSameProject(clipboardState.sourceBaseDir, baseDir);
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
          const isAbsolute =
            file.path.startsWith('/') ||
            file.path.startsWith('~/') ||
            file.path.startsWith('\\\\') ||
            /^[A-Za-z]:[\\/]/.test(file.path);
          const absolutePath = isAbsolute ? file.path : `${sourceRoot}/${file.path}`;
          const readOnly = true;
          console.log('Pasting context file', { file, pathToAdd: absolutePath, readOnly, isSameProject });
          await api.addFile(baseDir, taskId, absolutePath, readOnly);
        }
      });

      await Promise.all(jobs);
      useContextFilesClipboard.getState().clear();
    } catch (error) {
      console.error('Failed to paste context files:', error);
    }
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
        count={enabledFileCount}
        totalRuleCount={userContextFiles.length}
        isOpen={isOpen}
        totalStats={totalStats}
        treeData={contextTreeData}
        expandedItems={contextExpandedItems}
        setExpandedItems={setContextExpandedItems}
        contextFilesMap={effectiveContextFilesMap}
        updatedFiles={[]}
        fileTokensInfo={fileTokensInfo}
        os={os}
        actions={contextActions}
        emptyContent={<EmptyContextInfo mode={mode} />}
        onToggle={onToggle}
        onToggleContextFiles={handleToggleContextFiles}
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
