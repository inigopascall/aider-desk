import { ContextFile, Mode, OS, TokensCost } from '@common/types';
import { MouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HiOutlineTrash, HiPlus } from 'react-icons/hi';
import { BiCopy, BiPaste } from 'react-icons/bi';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

import { WorkspaceSection } from './WorkspaceSection';
import { EmptyContextInfo } from './EmptyContextInfo';
import { collectVisibleFilePaths, createFileTree, normalizePath } from './types';

import type { TreeItem } from './types';

import { Tooltip } from '@/components/ui/Tooltip';
import { useShiftRangeSelection } from '@/hooks/useShiftRangeSelection';
import { useApi } from '@/contexts/ApiContext';
import { useContextFilesClipboard, useHasCopiedFiles } from '@/stores/contextFilesClipboardStore';
import { useTaskStore } from '@/stores/taskStore';
import { showErrorNotification } from '@/utils/notifications';
import { useFileEditorStore } from '@/stores/fileEditorStore';

// UI state for a context file whose disabled flag was changed by a checkbox click and is not yet
// confirmed by the backend. `opId` is the click that owns the entry; `settled` is set once that
// click's request has succeeded.
type PendingToggle = {
  disabled: boolean;
  opId: number;
  settled: boolean;
};

type PendingState = {
  scope: string;
  toggles: Map<string, PendingToggle>;
};

const NO_PENDING_TOGGLES = new Map<string, PendingToggle>();

const noop = () => undefined;

const getScope = (baseDir: string, taskId: string) => `${baseDir}\u0000${taskId}`;

// True when the task store already shows every given file in the requested state.
// Files no longer in context count as matching.
const storeMatches = (taskId: string, normalizedPaths: string[], disabled: boolean): boolean => {
  const files = useTaskStore.getState().taskStateMap.get(taskId)?.contextFiles ?? [];
  return normalizedPaths.every((path) => {
    const file = files.find((candidate) => normalizePath(candidate.path) === path);
    return !file || Boolean(file.disabled) === disabled;
  });
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
  onDropFile: (item: TreeItem) => (e: MouseEvent<HTMLButtonElement>) => void;
  editMode?: boolean;
  isHidden?: boolean;
  onToggleHidden?: () => void;
  showBorderTop?: boolean;
};

export const ContextFilesSectionComponent = ({
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
  const openFile = useFileEditorStore((state) => state.openFile);

  const api = useApi();
  const hasCopiedFiles = useHasCopiedFiles();
  const copyToClipboard = useContextFilesClipboard((s) => s.copy);

  const [contextExpandedItems, setContextExpandedItems] = useState<string[]>([]);

  const scope = getScope(baseDir, taskId);
  const [pendingState, setPendingState] = useState<PendingState>(() => ({ scope, toggles: new Map() }));
  const pendingToggles = pendingState.scope === scope ? pendingState.toggles : NO_PENDING_TOGGLES;
  const nextOpIdRef = useRef(0);
  const requestChainRef = useRef<Promise<void>>(Promise.resolve());

  const effectiveUserContextFiles = useMemo(() => {
    if (pendingToggles.size === 0) return userContextFiles;
    return userContextFiles.map((file) => {
      const pending = pendingToggles.get(normalizePath(file.path));
      return pending && Boolean(file.disabled) !== pending.disabled ? { ...file, disabled: pending.disabled } : file;
    });
  }, [userContextFiles, pendingToggles]);

  const effectiveContextFilesMap = useMemo(() => {
    if (pendingToggles.size === 0) return contextFilesMap;
    const map = new Map(contextFilesMap);
    for (const [path, pending] of pendingToggles) {
      const file = map.get(path);
      if (file && Boolean(file.disabled) !== pending.disabled) {
        map.set(path, { ...file, disabled: pending.disabled });
      }
    }
    return map;
  }, [contextFilesMap, pendingToggles]);

  const sortedUserFiles = useMemo(() => {
    return [...effectiveUserContextFiles].sort((a, b) => a.path.localeCompare(b.path));
  }, [effectiveUserContextFiles]);

  const contextTreeData = useMemo(() => {
    return createFileTree(sortedUserFiles, 'root');
  }, [sortedUserFiles]);

  const visibleFilePaths = useMemo(() => collectVisibleFilePaths(contextTreeData, contextExpandedItems), [contextTreeData, contextExpandedItems]);
  const { resolveRange } = useShiftRangeSelection(visibleFilePaths);
  const enabledFileCount = useMemo(() => effectiveUserContextFiles.filter((file) => !file.disabled).length, [effectiveUserContextFiles]);

  // Sends backend requests one at a time, in click order, so the last click is also the final backend state.
  const enqueueRequest = useCallback((request: () => Promise<void>): Promise<void> => {
    const result = requestChainRef.current.then(request);
    requestChainRef.current = result.then(noop, noop);
    return result;
  }, []);

  const handleToggleContextFiles = useCallback(
    (filePaths: string[], disabled: boolean, shiftKey: boolean) => {
      if (filePaths.length === 0) return;
      const paths = filePaths.length === 1 ? resolveRange(filePaths[0], shiftKey) : filePaths;
      const normalizedPaths = paths.map(normalizePath);
      const opScope = getScope(baseDir, taskId);
      const opId = ++nextOpIdRef.current;

      // Show the new state immediately. A later click on the same file takes over its entry.
      setPendingState((prev) => {
        const toggles = new Map<string, PendingToggle>(prev.scope === opScope ? prev.toggles : []);
        for (const path of normalizedPaths) {
          toggles.set(path, { disabled, opId, settled: false });
        }
        return { scope: opScope, toggles };
      });

      // Clears or settles the entries this click still owns. Entries taken over by a later click are left alone.
      const releaseOwnedEntries = (release: 'clear' | 'settle') => {
        setPendingState((prev) => {
          if (prev.scope !== opScope) return prev;
          let toggles: Map<string, PendingToggle> | null = null;
          for (const path of normalizedPaths) {
            const entry = prev.toggles.get(path);
            if (!entry || entry.opId !== opId) continue;
            if (!toggles) toggles = new Map(prev.toggles);
            if (release === 'clear') {
              toggles.delete(path);
            } else {
              toggles.set(path, { ...entry, settled: true });
            }
          }
          return toggles ? { scope: opScope, toggles } : prev;
        });
      };

      const requestContextFilesRefresh = () => {
        void enqueueRequest(() => api.refreshContextFiles(baseDir, taskId)).catch(noop);
      };

      void enqueueRequest(() => api.setContextFilesDisabled(baseDir, taskId, paths, disabled)).then(
        () => {
          if (storeMatches(taskId, normalizedPaths, disabled)) {
            releaseOwnedEntries('clear');
          } else {
            // The confirming context-files update has not arrived yet; keep showing the new state until it does.
            releaseOwnedEntries('settle');
            requestContextFilesRefresh();
          }
        },
        (error: unknown) => {
          releaseOwnedEntries('clear');
          showErrorNotification(error instanceof Error ? error.message : String(error));
          requestContextFilesRefresh();
        },
      );
    },
    [api, baseDir, taskId, resolveRange, enqueueRequest],
  );

  // Once a click's request has succeeded, the next context-files update from the backend is authoritative for its files.
  useEffect(
    () =>
      useTaskStore.subscribe((state, prevState) => {
        if (state.taskStateMap.get(taskId)?.contextFiles === prevState.taskStateMap.get(taskId)?.contextFiles) return;
        setPendingState((prev) => {
          if (prev.scope !== scope) return prev;
          let toggles: Map<string, PendingToggle> | null = null;
          for (const [path, entry] of prev.toggles) {
            if (!entry.settled) continue;
            if (!toggles) toggles = new Map(prev.toggles);
            toggles.delete(path);
          }
          return toggles ? { scope, toggles } : prev;
        });
      }),
    [scope, taskId],
  );

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

  const addFile = useCallback(() => (): void => {}, []);

  const handleCopy = useCallback(() => {
    // userContextFiles already excludes rule files (computed in Workspace.tsx),
    // so rules are intentionally not carried across tasks/projects.
    copyToClipboard(userContextFiles, baseDir);
  }, [copyToClipboard, userContextFiles, baseDir]);

  const handlePaste = useCallback(async () => {
    const clipboardState = useContextFilesClipboard.getState();

    if (!clipboardState.sourceBaseDir || clipboardState.copiedFiles.length === 0) {
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
            openFile(baseDir, filePath, taskId);
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
    </>
  );
};

export const ContextFilesSection = memo(ContextFilesSectionComponent);
