import { ContextFile } from '@common/types';
import { Activity, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MdOutlineRefresh } from 'react-icons/md';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';

import { SectionHeader } from './SectionHeader';
import { FileViewerModal } from './FileViewerModal';

import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { showErrorNotification } from '@/utils/notifications';

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
  const [files, setFiles] = useState<ContextFile[]>([]);
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
          count={files.length}
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
                <button
                  key={file.path}
                  className="block w-full px-2 py-1 text-left text-2xs text-text-primary hover:bg-bg-secondary rounded truncate"
                  onClick={() => setPreviewFilePath(file.path)}
                >
                  {file.path}
                </button>
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