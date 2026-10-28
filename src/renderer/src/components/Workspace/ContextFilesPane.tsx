import { ContextManifestEntry, ContextManifestSection, Mode, TokensCost } from '@common/types';
import { Activity, memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MdOutlineRefresh } from 'react-icons/md';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';

import { SectionHeader } from './SectionHeader';
import { ContextManifestSectionView } from './ContextManifestSectionView';
import { ContextFilesActions } from './ContextFilesActions';
import { EmptyContextInfo } from './EmptyContextInfo';
import { useContextFileSelection } from './useContextFileSelection';
import { buildContextFileTokenUsage } from './context-token-usage';

import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { useTaskContextManifest, useTaskTokensInfo } from '@/stores/taskStore';
import { showErrorNotification } from '@/utils/notifications';

type Props = {
  mode: Mode;
  baseDir: string;
  taskId: string;
  isOpen: boolean;
  totalStats: { additions: number; deletions: number };
  fileTokensInfo?: Record<string, TokensCost> | null;
  showFileDialog: () => void;
  onDropAllFiles: () => void;
  refreshContextFiles: () => Promise<void>;
  onToggle: () => void;
  editMode?: boolean;
  isHidden?: boolean;
  onToggleHidden?: () => void;
  showBorderTop?: boolean;
};

// Shows every file the agent can receive, in the order the model receives it, straight from the task's context manifest.
const ContextFilesPaneComponent = ({
  mode,
  baseDir,
  taskId,
  isOpen,
  totalStats,
  fileTokensInfo,
  showFileDialog,
  onDropAllFiles,
  refreshContextFiles,
  onToggle,
  editMode,
  isHidden,
  onToggleHidden,
  showBorderTop,
}: Props) => {
  const { t } = useTranslation();
  const api = useApi();
  const openFile = useFileEditorStore((state) => state.openFile);
  const manifest = useTaskContextManifest(taskId);
  const tokensInfo = useTaskTokensInfo(taskId);
  const { sections, setSelection } = useContextFileSelection(baseDir, taskId, manifest);
  const tokenUsage = useMemo(() => buildContextFileTokenUsage(tokensInfo, mode, sections, baseDir), [tokensInfo, mode, sections, baseDir]);
  const [isRefreshingRules, setIsRefreshingRules] = useState(false);
  const [isRegeneratingMappings, setIsRegeneratingMappings] = useState(false);

  const { sentCount, totalCount } = useMemo(() => {
    let sent = 0;
    let total = 0;
    for (const section of sections) {
      total += section.entries.length;
      sent += section.entries.filter((entry) => entry.delivery !== 'none').length;
    }
    return { sentCount: sent, totalCount: total };
  }, [sections]);

  const handleOpenFile = useCallback((path: string) => openFile(baseDir, path, taskId), [openFile, baseDir, taskId]);

  const handleRefreshRules = useCallback(async () => {
    setIsRefreshingRules(true);
    try {
      await refreshContextFiles();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to refresh rules files:', error);
    } finally {
      setIsRefreshingRules(false);
    }
  }, [refreshContextFiles]);

  const handleRegenerateMappings = useCallback(async () => {
    setIsRegeneratingMappings(true);
    try {
      const result = await api.regenerateRepositoryMappings(baseDir, taskId);
      if (!result.success) {
        showErrorNotification(t('contextFiles.repositoryMappingsFailed', { error: result.error || t('common.error') }));
      }
    } catch (error) {
      showErrorNotification(String(error));
    } finally {
      setIsRegeneratingMappings(false);
    }
  }, [api, baseDir, taskId, t]);

  const handleDropFile = useCallback(
    (entry: ContextManifestEntry) => {
      let pathToDrop = entry.path;
      if (pathToDrop.startsWith(baseDir + '/') || pathToDrop.startsWith(baseDir + '\\')) {
        pathToDrop = pathToDrop.slice(baseDir.length + 1);
      }
      api.dropFile(baseDir, taskId, pathToDrop);
    },
    [api, baseDir, taskId],
  );

  const handleRemoveMapping = useCallback(
    (entry: ContextManifestEntry) => {
      void api.deleteRepositoryMapping(baseDir, entry.path).catch((error: unknown) => {
        showErrorNotification(t('contextFiles.repositoryMappingsRemoveFailed', { error: String(error) }));
      });
    },
    [api, baseDir, t],
  );

  const renderSectionActions = (section: ContextManifestSection) => {
    switch (section.id) {
      case 'rules':
        return (
          <Tooltip content={t('contextFiles.refresh')}>
            <button className="p-1.5 rounded-md hover:bg-bg-tertiary transition-colors" onClick={handleRefreshRules} disabled={isRefreshingRules}>
              <MdOutlineRefresh className={clsx('w-4 h-4', isRefreshingRules && 'animate-spin')} />
            </button>
          </Tooltip>
        );
      case 'mappings':
        return (
          <Tooltip content={isRegeneratingMappings ? t('contextFiles.regeneratingMappings') : t('contextFiles.regenerateMappings')}>
            <button className="p-1.5 rounded-md hover:bg-bg-tertiary transition-colors" onClick={handleRegenerateMappings} disabled={isRegeneratingMappings}>
              <MdOutlineRefresh className={clsx('w-4 h-4', isRegeneratingMappings && 'animate-spin')} />
            </button>
          </Tooltip>
        );
      case 'files':
        return (
          <ContextFilesActions baseDir={baseDir} taskId={taskId} entries={section.entries} showFileDialog={showFileDialog} onDropAllFiles={onDropAllFiles} />
        );
    }
  };

  const renderSectionEmpty = (section: ContextManifestSection) => {
    switch (section.id) {
      case 'rules':
        return <div className="px-2 py-1 text-2xs text-text-muted">{t('contextFiles.rulesEmpty')}</div>;
      case 'mappings':
        return <div className="px-2 py-1 text-2xs text-text-muted">{t('contextFiles.repositoryMappingsEmpty')}</div>;
      case 'files':
        return (
          <div className="relative h-48">
            <EmptyContextInfo mode={mode} />
          </div>
        );
    }
  };

  const getRemoveHandler = (section: ContextManifestSection) => {
    switch (section.id) {
      case 'files':
        return handleDropFile;
      case 'mappings':
        return handleRemoveMapping;
      default:
        return undefined;
    }
  };

  return (
    <motion.div
      className={clsx('flex flex-col overflow-hidden min-h-[40px]', showBorderTop && 'border-t border-border-dark-light')}
      initial={false}
      animate={editMode ? { flexGrow: 0, flexShrink: 0 } : { flexGrow: isOpen ? 1 : 0, flexShrink: isOpen ? 1 : 0 }}
      transition={{ duration: 0.3, ease: 'easeIn' }}
    >
      <SectionHeader
        section="context"
        title={t('contextFiles.title')}
        count={sentCount}
        totalCount={totalCount}
        isOpen={isOpen}
        totalStats={totalStats}
        onToggle={onToggle}
        editMode={editMode}
        isHidden={isHidden}
        onToggleHidden={onToggleHidden}
      />
      <Activity mode={isOpen ? 'visible' : 'hidden'}>
        <div className="flex-grow w-full overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-bg-tertiary scrollbar-track-bg-primary-light scrollbar-rounded bg-bg-primary-light-strong pb-1">
          {manifest === null ? (
            <div className="p-2 text-2xs text-text-muted">{t('common.loading')}</div>
          ) : (
            sections.map((section) => (
              <ContextManifestSectionView
                key={section.id}
                section={section}
                fileTokensInfo={fileTokensInfo}
                tokenTotal={tokenUsage.totals[section.id]}
                entryTokenUsage={tokenUsage.entries[section.id]}
                maxFileTokens={tokenUsage.maxTokens}
                actions={renderSectionActions(section)}
                emptyContent={renderSectionEmpty(section)}
                removeTooltip={section.id === 'mappings' ? t('contextFiles.removeMappingFile') : undefined}
                onSetSelection={setSelection}
                onOpenFile={handleOpenFile}
                onRemoveEntry={getRemoveHandler(section)}
              />
            ))
          )}
        </div>
      </Activity>
    </motion.div>
  );
};

export const ContextFilesPane = memo(ContextFilesPaneComponent);
