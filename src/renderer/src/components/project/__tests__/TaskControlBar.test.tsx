import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AVAILABLE_WORKFLOWS } from '@common/types';

import { TaskControlBar } from '../TaskControlBar';

vi.mock('@/contexts/ProjectSettingsContext', () => ({
  useProjectSettings: () => ({
    projectSettings: {
      enabledWorkflows: [AVAILABLE_WORKFLOWS[0].id],
      autonomyModeLocked: false,
    },
    saveProjectSettings: vi.fn(),
  }),
}));

vi.mock('@/components/PromptField/ModeSelector', () => ({
  ModeSelector: (props: { disabled?: boolean }) => <div data-testid="mode-selector" data-disabled={String(!!props.disabled)} />,
}));

vi.mock('@/components/AgentSelector', () => ({
  AgentSelector: (props: { disabled?: boolean }) => <div data-testid="agent-selector" data-disabled={String(!!props.disabled)} />,
}));

vi.mock('@/components/PromptField/AutonomySelector', () => ({
  AutonomySelector: (props: { disabled?: boolean }) => <div data-testid="autonomy-selector" data-disabled={String(!!props.disabled)} />,
}));

vi.mock('@/components/PromptField/WorkflowSelector', () => ({
  WorkflowSelector: (props: { selectedWorkflowId: string | null; onWorkflowClick: (workflowId: string) => void }) => (
    <button data-testid="workflow-selector" data-selected={props.selectedWorkflowId ?? ''} onClick={() => props.onWorkflowClick(AVAILABLE_WORKFLOWS[0].id)}>
      Workflow
    </button>
  ),
}));

vi.mock('@/components/PromptField/WorkflowConfigModal', () => ({
  WorkflowConfigModal: (props: { onCancel: () => void; onSaveAndClose: () => void; onSaveAndGo: () => void }) => (
    <div data-testid="workflow-config-modal">
      <button onClick={props.onCancel}>Cancel workflow</button>
      <button onClick={props.onSaveAndClose}>Save workflow</button>
      <button onClick={props.onSaveAndGo}>Run workflow</button>
    </div>
  ),
}));

vi.mock('@/components/common/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock('@/components/extensions/ExtensionComponentWrapper', () => ({
  ExtensionComponentWrapper: () => null,
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const task = {
  id: 'task-1',
  name: 'Test task',
  baseDir: '/test/project',
  state: 'in-progress',
  currentMode: 'agent',
  agentTotalCost: 0,
  aiderTotalCost: 0,
};

const renderBar = (
  selectedWorkflowId: string | null,
  onWorkflowChange = vi.fn(),
  onWorkflowRun = vi.fn(),
) =>
  render(
    <TaskControlBar
      baseDir="/test/project"
      task={task}
      isActive
      mode="agent"
      onModeChanged={vi.fn()}
      clearMessages={vi.fn()}
      selectedWorkflowId={selectedWorkflowId}
      onWorkflowChange={onWorkflowChange}
      onWorkflowRun={onWorkflowRun}
    />,
  );

describe('TaskControlBar workflow controls', () => {
  it('keeps standard controls enabled without a workflow', () => {
    renderBar(null);

    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-disabled', 'false');
    expect(screen.getByTestId('agent-selector')).toHaveAttribute('data-disabled', 'false');
    expect(screen.getByTestId('autonomy-selector')).toHaveAttribute('data-disabled', 'false');
    expect(screen.getByTestId('workflow-selector')).toBeInTheDocument();
  });

  it('disables standard controls while a workflow is selected', () => {
    const workflowId = AVAILABLE_WORKFLOWS[0].id;
    renderBar(workflowId);

    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('agent-selector')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('autonomy-selector')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('workflow-selector')).toHaveAttribute('data-selected', workflowId);
  });

  it('opens the configuration modal for an inactive workflow without changing selection', () => {
    const onWorkflowChange = vi.fn();
    renderBar(null, onWorkflowChange);

    screen.getByTestId('workflow-selector').click();

    expect(screen.getByTestId('workflow-config-modal')).toBeInTheDocument();
    expect(onWorkflowChange).not.toHaveBeenCalled();
  });

  it('closes the modal on cancel without changing selection', () => {
    const onWorkflowChange = vi.fn();
    renderBar(null, onWorkflowChange);

    screen.getByTestId('workflow-selector').click();
    screen.getByText('Cancel workflow').click();

    expect(screen.queryByTestId('workflow-config-modal')).not.toBeInTheDocument();
    expect(onWorkflowChange).not.toHaveBeenCalled();
  });

  it('selects the workflow and closes the modal on Save & Close', () => {
    const onWorkflowChange = vi.fn();
    const workflowId = AVAILABLE_WORKFLOWS[0].id;
    renderBar(null, onWorkflowChange);

    screen.getByTestId('workflow-selector').click();
    screen.getByText('Save workflow').click();

    expect(onWorkflowChange).toHaveBeenCalledWith(workflowId);
    expect(screen.queryByTestId('workflow-config-modal')).not.toBeInTheDocument();
  });

  it('runs the workflow and closes the modal on Save & Go', () => {
    const onWorkflowChange = vi.fn();
    const onWorkflowRun = vi.fn();
    const workflowId = AVAILABLE_WORKFLOWS[0].id;
    renderBar(null, onWorkflowChange, onWorkflowRun);

    screen.getByTestId('workflow-selector').click();
    screen.getByText('Run workflow').click();

    expect(onWorkflowRun).toHaveBeenCalledWith(workflowId);
    expect(onWorkflowChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('workflow-config-modal')).not.toBeInTheDocument();
  });

  it('deselects an active workflow without opening the modal', () => {
    const onWorkflowChange = vi.fn();
    const workflowId = AVAILABLE_WORKFLOWS[0].id;
    renderBar(workflowId, onWorkflowChange);

    screen.getByTestId('workflow-selector').click();

    expect(onWorkflowChange).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId('workflow-config-modal')).not.toBeInTheDocument();
  });
});
