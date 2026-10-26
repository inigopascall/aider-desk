import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReasoningSelector } from '../ReasoningSelector';
import { TemperatureSelector } from '../TemperatureSelector';

import { render } from '@/__tests__/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${Object.values(options).join('|')})` : key),
  }),
}));

const CLEAR_LABEL = 'taskModelSettings.useAgentProfileSetting';

describe('ReasoningSelector', () => {
  it('shows the source label for an inherited value, with no clear button', () => {
    render(<ReasoningSelector reasoning={{ value: 'medium', source: 'agent-profile' }} agentProfileName="WORKHORSE" onChange={vi.fn()} />);

    expect(screen.getByText(/taskModelSettings\.sourceAgentProfile/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CLEAR_LABEL })).not.toBeInTheDocument();
  });

  it('shows a clear button for an override, and clicking it sends null', () => {
    const onChange = vi.fn();
    render(<ReasoningSelector reasoning={{ value: 'high', source: 'task' }} onChange={onChange} />);

    expect(screen.queryByText(/taskModelSettings\.sourceAgentProfile/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: CLEAR_LABEL }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('sets an override from the drop-down', () => {
    const onChange = vi.fn();
    render(<ReasoningSelector reasoning={{ value: 'provider-default', source: 'default' }} onChange={onChange} />);

    fireEvent.click(screen.getByText('taskModelSettings.reasoningLabel'));
    fireEvent.click(
      screen.getByRole('option', {
        name: 'taskModelSettings.reasoningOptions.high',
      }),
    );

    expect(onChange).toHaveBeenCalledWith('high');
  });
});

describe('TemperatureSelector', () => {
  it('shows the source label for a value inherited from the agent profile or the Model Library', () => {
    const { rerender } = render(
      <TemperatureSelector
        temperature={{
          value: 0.4,
          source: 'agent-profile',
          locked: false,
          clearedByReasoning: false,
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/taskModelSettings\.sourceAgentProfile/)).toBeInTheDocument();

    rerender(
      <TemperatureSelector
        temperature={{
          value: 0.7,
          source: 'model-library',
          locked: false,
          clearedByReasoning: false,
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/taskModelSettings\.sourceModelLibrary/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CLEAR_LABEL })).not.toBeInTheDocument();
  });

  it('shows a clear button for an override, and clicking it sends null', () => {
    const onChange = vi.fn();
    render(
      <TemperatureSelector
        temperature={{
          value: 0.7,
          source: 'task',
          locked: false,
          clearedByReasoning: false,
        }}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('0.7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: CLEAR_LABEL }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('sets "Model default" from the popover', () => {
    const onChange = vi.fn();
    render(
      <TemperatureSelector
        temperature={{
          value: 0.4,
          source: 'agent-profile',
          locked: false,
          clearedByReasoning: false,
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('taskModelSettings.temperatureLabel'));
    expect(screen.getByRole('slider')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'taskModelSettings.modelDefault' }));

    expect(onChange).toHaveBeenCalledWith('model-default');
  });

  it('a locked temperature is not interactive', () => {
    const onChange = vi.fn();
    render(
      <TemperatureSelector
        temperature={{
          value: undefined,
          source: 'default',
          locked: true,
          clearedByReasoning: false,
        }}
        onChange={onChange}
      />,
    );

    const locked = screen.getByTestId('temperature-locked');
    expect(locked).toHaveTextContent('taskModelSettings.modelDefault');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    fireEvent.click(locked);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
