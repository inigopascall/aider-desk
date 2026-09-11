import { ContextFile } from '@common/types';
import { Activity, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HiX } from 'react-icons/hi';
import { MdOutlineMap, MdOutlineRefresh } from 'react-icons/md';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';

import { SectionHeader } from './SectionHeader';
import { FileViewerModal } from './FileViewerModal';
import { TriStateCheckbox } from '@/components/common/TriStateCheckbox';
import { useProjectSettings } from '@/contexts/ProjectSettingsContext';
import { useShiftRangeSelection } from '@/hooks/useShiftRangeSelection';

import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { showErrorNotification } from '@/utils/notifications';

const getFileName = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath;

type Props = {
  baseDir: string;
  taskId: string;
  isOpen: boolean;
  totalStats: { additions: number; deletions: number };
  visitedSections: Set<string>;
  onToggle: () => void;
  editMode?: boolean;
  isHidden?: boolean;
  onToggleHidden?: () => void;
  showBorderTop?: boolean;
};

export const RepositoryMappingsSection = ({
  baseDir,
  taskId,
  isOpen,
  totalStats,
  visitedSections,
  onToggle,
  editMode,
  isHidden,
  onToggleHidden,
  showBorderTop,
}: Props) => {
  const { t } = useTranslation();
  const api = useApi();
  const { projectSettings, saveProjectSettings } = useProjectSettings();
  const [files, setFiles] = useState<ContextFile[]>([]);
  const disabledFiles = projectSettings?.disabledRepositoryMappingFiles ?? [];
  const orderedKeys = useMemo(() => files.map((file) => file.path), [files]);
  const { resolveRange } = useShiftRangeSelection(orderedKeys);
  const enabledCount = files.length - files.filter((file) => disabledFiles.includes(file.path)).length;
  const [isLoading, setIsLoading] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    setIsLoading(true);
    try {
      setFiles(await api.getRepositoryMappings(baseDir));
    } catch (error) {
      showErrorNotification(String(error));
    } finally {
      setIsLoading(false);
    }
  }, [api, baseDir]);

  useEffect(() => {
    if (visitedSections.has('mappings')) {
      void loadFiles();
    }
  }, [visitedSections, loadFiles]);

  useEffect(() => api.addRepositoryMappingsUpdatedListener(baseDir, (data) => setFiles(data.files)), [api, baseDir]);

  const handleRegenerate = useCallback(async () => {
    setIsRegenerating(true);
    try {
      const result = await api.regenerateRepositoryMappings(baseDir, taskId);
      if (!result.success) {
        showErrorNotification(t('contextFiles.repositoryMappingsFailed', { error: result.error || t('common.error') }));
      } else {
        await loadFiles();
      }
    } catch (error) {
      showErrorNotification(String(error));
    } finally {
      setIsRegenerating(false);
    }
  }, [api, baseDir, taskId, loadFiles, t]);

  const handleToggleFile = useCallback(
    async (filePath: string, shiftKey: boolean) => {
      const paths = resolveRange(filePath, shiftKey);
      const disabled = new Set(disabledFiles);
      const shouldEnable = disabled.has(filePath);
      paths.forEach((path) => (shouldEnable ? disabled.delete(path) : disabled.add(path)));
      await saveProjectSettings({ disabledRepositoryMappingFiles: Array.from(disabled) });
    },
    [disabledFiles, resolveRange, saveProjectSettings],
  );

  const handleRemoveFile = useCallback(
    async (filePath: string) => {
      try {
        setFiles(await api.deleteRepositoryMapping(baseDir, filePath));
        if (disabledFiles.includes(filePath)) {
          await saveProjectSettings({ disabledRepositoryMappingFiles: disabledFiles.filter((path) => path !== filePath) });
        }
        if (previewFilePath === filePath) {
          setPreviewFilePath(null);
        }
      } catch (error) {
        showErrorNotification(t('contextFiles.repositoryMappingsRemoveFailed', { error: String(error) }));
      }
    },
    [api, baseDir, disabledFiles, previewFilePath, saveProjectSettings, t],
  );

  const actions = useMemo(
    () => (
      <Tooltip content={isRegenerating ? t('contextFiles.regeneratingMappings') : t('contextFiles.regenerateMappings')}>
        <button className="p-1.5 rounded-md hover:bg-bg-tertiary transition-colors" onClick={handleRegenerate} disabled={isRegenerating}>
          <MdOutlineRefresh className={clsx('w-4 h-4', isRegenerating && 'animate-spin')} />
        </button>
      </Tooltip>
    ),
    [handleRegenerate, isRegenerating, t],
  );

  return (
    <>
      <motion.div
        className={clsx('flex flex-col overflow-hidden min-h-[40px]', showBorderTop && 'border-t border-border-dark-light')}
        initial={false}
        animate={editMode ? { flexGrow: 0, flexShrink: 0 } : { flexGrow: isOpen ? 1 : 0, flexShrink: isOpen ? 1 : 0 }}
        transition={{ duration: 0.3, ease: 'easeIn' }}
      >
        <SectionHeader
          section="mappings"
          title={t('contextFiles.repositoryMappings')}
          count={enabledCount}
          totalCount={files.length}
          isOpen={isOpen}
          totalStats={totalStats}
          onToggle={onToggle}
          editMode={editMode}
          isHidden={isHidden}
          onToggleHidden={onToggleHidden}
          actions={actions}
        />
        <Activity mode={isOpen ? 'visible' : 'hidden'}>
          <div className="flex-grow overflow-y-auto bg-bg-primary-light-strong p-1">
            {isLoading ? (
              <div className="p-2 text-2xs text-text-muted">{t('common.loading')}</div>
            ) : files.length > 0 ? (
              files.map((file) => (
                <div key={file.path} className="group flex items-center w-full pr-1 rounded hover:bg-bg-secondary">
                  <Tooltip content={t('contextFiles.repositoryMappingFile')}>
                    <MdOutlineMap className="w-4 h-4 mx-1 text-text-muted flex-shrink-0" />
                  </Tooltip>
                  <TriStateCheckbox
                    state={disabledFiles.includes(file.path) ? 'unchecked' : 'checked'}
                    onChange={(shiftKey) => void handleToggleFile(file.path, shiftKey)}
                    aria-label={file.path}
                    className="mr-1"
                  />
                  <Tooltip content={file.path}>
                    <button
                      className={clsx('flex-grow min-w-0 px-2 py-1 text-left text-2xs truncate', disabledFiles.includes(file.path) ? 'text-text-muted' : 'text-text-primary')}
                      onClick={() => setPreviewFilePath(file.path)}
                    >
                      {getFileName(file.path)}
                    </button>
                  </Tooltip>
                  <Tooltip content={t('contextFiles.removeMappingFile')}>
                    <button
                      onClick={() => handleRemoveFile(file.path)}
                      className="px-1 py-1 rounded hover:bg-bg-primary-light text-text-muted hover:text-error-dark opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    >
                      <HiX className="w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              ))
            ) : (
              <div className="p-3 text-center text-2xs text-text-muted">{t('contextFiles.repositoryMappingsEmpty')}</div>
            )}
          </div>
        </Activity>
      </motion.div>

      {previewFilePath && <FileViewerModal filePath={previewFilePath} baseDir={baseDir} taskId={taskId} onClose={() => setPreviewFilePath(null)} />}
    </>
  );
};