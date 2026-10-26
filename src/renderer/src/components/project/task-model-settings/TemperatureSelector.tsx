import { EffectiveTemperature } from '@common/types';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IoMdClose } from 'react-icons/io';
import { MdKeyboardArrowUp } from 'react-icons/md';
import { VscLock } from 'react-icons/vsc';
import { clsx } from 'clsx';

import { Slider } from '@/components/common/Slider';
import { Tooltip } from '@/components/ui/Tooltip';
import { useClickOutside } from '@/hooks/useClickOutside';

export type TemperatureOverride = number | 'model-default' | null;

const formatTemperature = (value: number) => String(Math.round(value * 100) / 100);

type PopoverButtonProps = {
  label: string;
  selected: boolean;
  onClick: () => void;
};

const PopoverButton = ({ label, selected, onClick }: PopoverButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    className={clsx(
      'w-full px-2 py-1 rounded text-left text-xs transition-colors duration-200 hover:bg-bg-tertiary',
      selected ? 'text-text-primary bg-bg-tertiary' : 'text-text-tertiary',
    )}
  >
    {label}
  </button>
);

type Props = {
  temperature: EffectiveTemperature;
  agentProfileName?: string;
  onChange: (value: TemperatureOverride) => void;
  disabled?: boolean;
};

export const TemperatureSelector = ({ temperature, agentProfileName, onChange, disabled = false }: Props) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(containerRef, close, isOpen);

  const modelDefault = t('taskModelSettings.modelDefault');

  if (temperature.locked) {
    return (
      <Tooltip content={t('taskModelSettings.temperatureLockedTooltip')}>
        <span
          data-testid="temperature-locked"
          aria-disabled="true"
          className="flex items-center gap-1 text-2xs whitespace-nowrap text-text-muted opacity-60 cursor-not-allowed flex-shrink-0"
        >
          <span>{t('taskModelSettings.temperatureLabel')}</span>
          <span>{modelDefault}</span>
          <VscLock className="w-3 h-3 flex-shrink-0" />
        </span>
      </Tooltip>
    );
  }

  const isOverride = temperature.source === 'task';
  const valueLabel = temperature.value === undefined ? modelDefault : formatTemperature(temperature.value);

  const getSourceLabel = () => {
    if (temperature.clearedByReasoning) {
      return null;
    }
    if (temperature.source === 'agent-profile') {
      return t('taskModelSettings.sourceAgentProfile');
    }
    if (temperature.source === 'model-library') {
      return t('taskModelSettings.sourceModelLibrary');
    }
    return null;
  };
  const sourceLabel = getSourceLabel();
  const displayValue = sourceLabel
    ? t('taskModelSettings.inheritedValue', {
        value: valueLabel,
        source: sourceLabel,
      })
    : valueLabel;

  const getTooltip = () => {
    if (temperature.clearedByReasoning) {
      return t('taskModelSettings.temperatureClearedTooltip');
    }
    if (isOverride) {
      return t('taskModelSettings.overrideTooltip');
    }
    if (temperature.source === 'agent-profile') {
      return t('taskModelSettings.fromAgentProfile', {
        name: agentProfileName ?? '',
      });
    }
    if (temperature.source === 'model-library') {
      return t('taskModelSettings.fromModelLibrary');
    }
    return t('taskModelSettings.temperatureDefaultTooltip');
  };

  const handleToggle = () => {
    if (!isOpen) {
      setDraft(temperature.value ?? 1);
    }
    setIsOpen(!isOpen);
  };

  const handleSliderChange = (value: number) => {
    const rounded = Math.round(value * 10) / 10;
    setDraft(rounded);
    onChange(rounded);
  };

  const handleSelect = (value: TemperatureOverride) => {
    setIsOpen(false);
    onChange(value);
  };

  return (
    <div ref={containerRef} className="relative flex items-center flex-shrink-0">
      <Tooltip content={getTooltip()}>
        <button
          type="button"
          disabled={disabled}
          onClick={handleToggle}
          className="flex items-center gap-1 text-2xs whitespace-nowrap focus:outline-none transition-colors duration-200 hover:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-text-muted">{t('taskModelSettings.temperatureLabel')}</span>
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
        <div className="absolute top-full left-0 mt-1 w-56 rounded-md border border-border-default-dark bg-bg-primary-light shadow-lg z-50 p-3 space-y-2">
          <Slider min={0} max={1} step={0.1} value={draft} onChange={handleSliderChange} />
          <div className="flex flex-col gap-1">
            <PopoverButton
              selected={isOverride && temperature.value === undefined && !temperature.clearedByReasoning}
              label={modelDefault}
              onClick={() => handleSelect('model-default')}
            />
            <PopoverButton selected={!isOverride} label={t('taskModelSettings.useAgentProfileSetting')} onClick={() => handleSelect(null)} />
          </div>
        </div>
      )}
    </div>
  );
};
