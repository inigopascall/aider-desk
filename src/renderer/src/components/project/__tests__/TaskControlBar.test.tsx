import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TaskControlBar } from '../TaskControlBar';

vi.mock('@/contexts/ProjectSettingsContext', () => ({
  useProjectSettings: () => ({
    projectSettings: {
      enabledWorkflows: ['test-workflow'],
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
  WorkflowSelector: (props: { selectedWorkflowId: string | null }) => (
    <div data-testid="workflow-selector" data-selected={props.selectedWorkflowId ?? ''} />
  ),
}));

vi.mock('@/components/PromptField/WorkflowModelSetSelector', () => ({
  WorkflowModelSetSelector: (props: { selectedWorkflowId: string | null }) => (
    <div data-testid="workflow-model-set-selector" data-selected={props.selectedWorkflowId ?? ''} />
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
  currentMode: 'code',
  agentTotalCost: 0,
  aiderTotalCost: 0,
};

const renderBar = (selectedWorkflowId: string | null) =>
  render(
    <TaskControlBar
      baseDir="/test/project"
      task={task}
      isActive
      mode="code"
      onModeChanged={vi.fn()}
      clearMessages={vi.fn()}
      selectedWorkflowId={selectedWorkflowId}
      onWorkflowChange={vi.fn()}
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
    renderBar('test-workflow');

    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('agent-selector')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('autonomy-selector')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('workflow-selector')).toHaveAttribute('data-selected', 'test-workflow');
    expect(screen.getByTestId('workflow-model-set-selector')).toHaveAttribute('data-selected', 'test-workflow');
  });
});