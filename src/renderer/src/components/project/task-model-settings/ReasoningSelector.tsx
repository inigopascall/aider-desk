import { EffectiveReasoning, Reasoning } from '@common/types';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IoMdClose } from 'react-icons/io';
import { MdKeyboardArrowUp } from 'react-icons/md';
import { clsx } from 'clsx';

import { Tooltip } from '@/components/ui/Tooltip';
import { useClickOutside } from '@/hooks/useClickOutside';

export const REASONING_OPTIONS: Reasoning[] = ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

type OptionButtonProps = {
  label: string;
  selected: boolean;
  onClick: () => void;
};

const OptionButton = ({ label, selected, onClick }: OptionButtonProps) => (
  <button
    type="button"
    role="option"
    aria-selected={selected}
    onClick={onClick}
    className={clsx(
      'block w-full px-3 py-1 text-left text-xs whitespace-nowrap transition-colors duration-200 hover:bg-bg-tertiary',
      selected ? 'text-text-primary bg-bg-tertiary' : 'text-text-tertiary',
    )}
  >
    {label}
  </button>
);

type Props = {
  reasoning: EffectiveReasoning;
  agentProfileName?: string;
  onChange: (value: Reasoning | null) => void;
  disabled?: boolean;
};

export const ReasoningSelector = ({ reasoning, agentProfileName, onChange, disabled = false }: Props) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(containerRef, close, isOpen);

  const isOverride = reasoning.source === 'task';
  const valueLabel = t(`taskModelSettings.reasoningOptions.${reasoning.value}`);
  const displayValue =
    reasoning.source === 'agent-profile'
      ? t('taskModelSettings.inheritedValue', {
          value: valueLabel,
          source: t('taskModelSettings.sourceAgentProfile'),
        })
      : valueLabel;

  const getTooltip = () => {
    if (isOverride) {
      return t('taskModelSettings.overrideTooltip');
    }
    if (reasoning.source === 'agent-profile') {
      return t('taskModelSettings.fromAgentProfile', {
        name: agentProfileName ?? '',
      });
    }
    return t('taskModelSettings.reasoningDefaultTooltip');
  };

  const handleSelect = (value: Reasoning | null) => {
    setIsOpen(false);
    onChange(value);
  };

  return (
    <div ref={containerRef} className="relative flex items-center flex-shrink-0">
      <Tooltip content={getTooltip()}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen((open) => !open)}
          className="flex items-center gap-1 text-2xs whitespace-nowrap focus:outline-none transition-colors duration-200 hover:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-text-muted">{t('taskModelSettings.reasoningLabel')}</span>
          <span className={clsx(isOverride ? 'text-accent-primary font-medium' : 'text-text-muted-light')}>{displayValue}</span>
          <MdKeyboardArrowUp className="w-3 h-3 flex-shrink-0 rotate-180" />
        </button>
      </Tooltip>
      {isOverride && (
        <button
          type="button"
          disabled={disabled}
          aria-label={t('taskModelSettings.useAgentProfileSetting')}
          onClick={() => onChange(null)}
          className="ml-1 text-text-muted hover:text-text-primary disabled:cursor-not-allowed"
        >
          <IoMdClose className="w-3 h-3" />
        </button>
      )}
      {isOpen && (
        <div
          role="listbox"
          className="absolute top-full left-0 mt-1 min-w-[11rem] overflow-hidden rounded-md border border-border-default-dark bg-bg-primary-light shadow-lg z-50"
        >
          <OptionButton selected={!isOverride} label={t('taskModelSettings.useAgentProfileSetting')} onClick={() => handleSelect(null)} />
          {REASONING_OPTIONS.map((option) => (
            <OptionButton
              key={option}
              selected={isOverride && reasoning.value === option}
              label={t(`taskModelSettings.reasoningOptions.${option}`)}
              onClick={() => handleSelect(option)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
