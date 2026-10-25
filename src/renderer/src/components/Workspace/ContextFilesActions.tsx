import { ContextManifestEntry } from '@common/types';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { HiOutlineTrash, HiPlus } from 'react-icons/hi';
import { BiCopy, BiPaste } from 'react-icons/bi';
import { clsx } from 'clsx';

import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { useContextFilesClipboard, useHasCopiedFiles } from '@/stores/contextFilesClipboardStore';

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
  baseDir: string;
  taskId: string;
  entries: ContextManifestEntry[];
  showFileDialog: () => void;
  onDropAllFiles: () => void;
};

export const ContextFilesActions = ({ baseDir, taskId, entries, showFileDialog, onDropAllFiles }: Props) => {
  const { t } = useTranslation();
  const api = useApi();
  const hasCopiedFiles = useHasCopiedFiles();
  const copyToClipboard = useContextFilesClipboard((s) => s.copy);

  const handleCopy = useCallback(() => {
    // The Files section holds neither rules nor mappings, so neither is carried across tasks or projects.
    copyToClipboard(
      entries.map(({ path, readOnly }) => ({ path, readOnly })),
      baseDir,
    );
  }, [copyToClipboard, entries, baseDir]);

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
          // Same project: paths are already relative to the project root (or already
          // absolute for external read-only files). Preserve the original readOnly flag.
          await api.addFile(baseDir, taskId, file.path, file.readOnly);
        } else {
          // Different project: convert relative paths to absolute, force readOnly.
          // If the path is already absolute (e.g. a file from outside the source
          // project), use it as-is.
          const isAbsolute = file.path.startsWith('/') || file.path.startsWith('~/') || file.path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(file.path);
          const absolutePath = isAbsolute ? file.path : `${sourceRoot}/${file.path}`;
          await api.addFile(baseDir, taskId, absolutePath, true);
        }
      });

      await Promise.all(jobs);
      useContextFilesClipboard.getState().clear();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to paste context files:', error);
    }
  }, [api, baseDir, taskId]);

  return (
    <>
      <Tooltip content={t('contextFiles.dropAll')}>
        <button
          onClick={onDropAllFiles}
          className="p-1.5 hover:bg-bg-tertiary rounded-md text-text-muted hover:text-error transition-colors disabled:opacity-50"
          disabled={entries.length === 0}
        >
          <HiOutlineTrash className="w-4 h-4" />
        </button>
      </Tooltip>
      <Tooltip content={t('contextFiles.copyContextFiles')}>
        <button
          onClick={handleCopy}
          className="p-1.5 hover:bg-bg-tertiary rounded-md text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
          disabled={entries.length === 0}
        >
          <BiCopy className="w-4 h-4" />
        </button>
      </Tooltip>
      <Tooltip content={t('contextFiles.pasteContextFiles')}>
        <button
          onClick={handlePaste}
          className={clsx(
            'p-1.5 hover:bg-bg-tertiary rounded-md transition-colors disabled:opacity-50',
            hasCopiedFiles ? 'text-accent-primary hover:text-accent-primary' : 'text-text-muted hover:text-text-primary',
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
  );
};
