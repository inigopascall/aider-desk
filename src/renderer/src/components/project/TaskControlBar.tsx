import { AIDER_MODES, AutonomyMode, AVAILABLE_WORKFLOWS, DEFAULT_AUTONOMY_MODE, Mode, TaskData } from '@common/types';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FaInfoCircle } from 'react-icons/fa';
import { Tooltip } from '@/components/ui/Tooltip';
import { MdPlaylistRemove, MdUndo } from 'react-icons/md';
import { VscTerminal } from 'react-icons/vsc';
import { clsx } from 'clsx';

import { AgentSelector } from '@/components/AgentSelector';
import { ModeSelector } from '@/components/PromptField/ModeSelector';
import { AutonomySelector } from '@/components/PromptField/AutonomySelector';
import { WorkflowSelector } from '@/components/PromptField/WorkflowSelector';
import { WorkflowModelSetSelector } from '@/components/PromptField/WorkflowModelSetSelector';
import { Button } from '@/components/common/Button';
import { ExtensionComponentWrapper } from '@/components/extensions/ExtensionComponentWrapper';
import { useProjectSettings } from '@/contexts/ProjectSettingsContext';

type Props = {
  baseDir: string;
  task: TaskData;
  isActive: boolean;
  mode: Mode;
  onModeChanged: (mode: Mode) => void;
  clearMessages: () => void;
  toggleTerminal?: () => void;
  terminalVisible?: boolean;
  showTaskInfoPanel?: boolean;
  onToggleTaskInfoPanel?: () => void;
  onExpandEditor?: () => void;
  onAutonomyModeChanged?: (mode: AutonomyMode) => void;
  showSettingsPage?: (pageId?: string, options?: Record<string, unknown>) => void;
  canUndoContextChange?: boolean;
  onUndoContextChange?: () => void;
  selectedWorkflowId?: string | null;
  onWorkflowChange?: (id: string | null) => void;
};

export const TaskControlBar = ({
  baseDir,
  task,
  isActive,
  mode,
  onModeChanged,
  clearMessages,
  toggleTerminal,
  terminalVisible = false,
  showTaskInfoPanel = false,
  onToggleTaskInfoPanel,
  onExpandEditor,
  onAutonomyModeChanged,
  showSettingsPage,
  canUndoContextChange,
  onUndoContextChange,
  selectedWorkflowId,
  onWorkflowChange,
}: Props) => {
  const { t } = useTranslation();
  const { projectSettings, saveProjectSettings } = useProjectSettings();

  // Only workflows enabled for this project are offered in the selector
  const enabledWorkflowIds = projectSettings?.enabledWorkflows ?? [];
  const availableWorkflows = useMemo(() => AVAILABLE_WORKFLOWS.filter((w) => enabledWorkflowIds.includes(w.id)), [enabledWorkflowIds]);

  // Clear a stale selection if the currently selected workflow is no longer available for this project
  useEffect(() => {
    if (selectedWorkflowId && !availableWorkflows.some((w) => w.id === selectedWorkflowId)) {
      onWorkflowChange?.(null);
    }
  }, [selectedWorkflowId, availableWorkflows, onWorkflowChange]);

  const handleAutonomyLockChanged = (locked: boolean) => {
    void saveProjectSettings({
      autonomyModeLocked: locked,
    });
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5">
      <div className="flex items-center gap-1.5">
        <ModeSelector baseDir={baseDir} mode={mode} onModeChange={onModeChanged} />
        {!AIDER_MODES.includes(mode) && <AgentSelector projectDir={baseDir} task={task} isActive={isActive} showSettingsPage={showSettingsPage} />}
      </div>

      <div className="flex flex-1 items-center gap-1.5">
        <AutonomySelector
          mode={task.autonomyMode ?? DEFAULT_AUTONOMY_MODE}
          locked={projectSettings?.autonomyModeLocked ?? false}
          onChange={onAutonomyModeChanged}
          onLockChange={handleAutonomyLockChanged}
        />
        {onWorkflowChange && availableWorkflows.length > 0 && (
          <>
            <WorkflowSelector
              workflows={availableWorkflows}
              selectedWorkflowId={selectedWorkflowId ?? null}
              onChange={onWorkflowChange}
            />
            <WorkflowModelSetSelector baseDir={baseDir} task={task} selectedWorkflowId={selectedWorkflowId ?? null} />
          </>
        )}
        <ExtensionComponentWrapper placement="task-input-toolbar-left" />
        <div className="ml-auto flex items-center gap-1">
          <ExtensionComponentWrapper placement="task-input-toolbar-right" />
          {toggleTerminal && (
            <Tooltip content={t(terminalVisible ? 'terminal.minimize' : 'terminal.addTerminal')}>
              <Button
                variant="text"
                color="tertiary"
                onClick={toggleTerminal}
                className={terminalVisible ? 'bg-bg-secondary-light' : ''}
                size="xs"
                aria-label={t(terminalVisible ? 'terminal.minimize' : 'terminal.addTerminal')}
                title={t(terminalVisible ? 'terminal.minimize' : 'terminal.addTerminal')}
              >
                <VscTerminal className="w-3.5 h-3.5 text-text-secondary" />
              </Button>
            </Tooltip>
          )}
          {canUndoContextChange && onUndoContextChange ? (
            <Button variant="text" color="tertiary" onClick={onUndoContextChange} size="xs" tooltip={t('promptField.undoContextChange')}>
              <MdUndo className="w-4 h-4 text-text-secondary" />
              <span className="hidden sm:inline ml-1 text-text-secondary">{t('common.undo')}</span>
            </Button>
          ) : (
            <Tooltip content={t('promptField.clearChat')}>
              <Button
                variant="text"
                color="tertiary"
                onClick={() => clearMessages()}
                size="xs"
                aria-label={t('promptField.clearChat')}
                title={t('promptField.clearChat')}
              >
                <MdPlaylistRemove className="w-4 h-4 text-text-secondary" />
              </Button>
            </Tooltip>
          )}
          {onExpandEditor && (
            <Tooltip content={t('promptField.expandEditor')}>
              <Button
                variant="text"
                color="tertiary"
                onClick={onExpandEditor}
                size="xs"
                aria-label={t('promptField.expandEditor')}
                title={t('promptField.expandEditor')}
              >
                <MdOutlineFullscreen className="w-4 h-4 text-text-secondary" />
              </Button>
            </Tooltip>
          )}
          {onToggleTaskInfoPanel && (
            <Tooltip content={t('promptField.taskInfo')}>
              <Button
                variant="text"
                onClick={onToggleTaskInfoPanel}
                className={clsx('py-1.5', showTaskInfoPanel && 'bg-bg-secondary-light')}
                size="xs"
                color="tertiary"
                aria-label={t('promptField.taskInfo')}
                title={t('promptField.taskInfo')}
              >
                <FaInfoCircle className={clsx('w-3.5 h-3.5', showTaskInfoPanel ? 'text-text-secondary' : 'text-text-tertiary')} />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};
