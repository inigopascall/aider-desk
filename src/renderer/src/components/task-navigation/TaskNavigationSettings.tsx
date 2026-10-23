import { Fragment, useEffect, useState } from 'react';
import {
  Model,
  SettingsData,
  TaskNavigationSettings as TaskNavigationSettingsData,
  deriveProjectPrefix,
  getTaskNavigationSettings,
  normalizeProjectKey,
} from '@common/types';
import { getProviderModelId } from '@common/agent';
import { useTranslation } from 'react-i18next';
import { MdAdd, MdRemove } from 'react-icons/md';

import { getProjectName } from './utils';

import { Checkbox } from '@/components/common/Checkbox';
import { InfoIcon } from '@/components/common/InfoIcon';
import { Input } from '@/components/common/Input';
import { ModelSelectorWrapper } from '@/components/common/ModelSelectorWrapper';
import { Section } from '@/components/common/Section';
import { useApi } from '@/contexts/ApiContext';

type Props = {
  settings: SettingsData;
  setSettings: (settings: SettingsData) => void;
};

const sanitizePrefix = (value: string): string =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);

/** Settings for task numbers, topic maps, the global search index and the quick switcher. */
export const TaskNavigationSettings = ({ settings, setSettings }: Props) => {
  const { t } = useTranslation();
  const api = useApi();
  const navigation = getTaskNavigationSettings(settings);
  const [projectDirs, setProjectDirs] = useState<string[]>([]);
  const [countText, setCountText] = useState(String(navigation.quickSwitcherCount));

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.getOpenProjects())
      .then((projects) => {
        if (!cancelled) {
          setProjectDirs(projects.map((project) => project.baseDir));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const update = (patch: Partial<TaskNavigationSettingsData>) => {
    setSettings({
      ...settings,
      taskNavigation: {
        ...(settings.taskNavigation ?? {}),
        ...patch,
      },
    });
  };

  const handleCountChange = (value: string) => {
    setCountText(value);
    const count = Number(value);
    if (value.trim() !== '' && Number.isFinite(count)) {
      update({ quickSwitcherCount: count });
    }
  };

  const getPrefixOverride = (baseDir: string): string => {
    const key = normalizeProjectKey(baseDir);
    return Object.entries(navigation.projectPrefixes).find(([dir]) => normalizeProjectKey(dir) === key)?.[1] ?? '';
  };

  const handlePrefixChange = (baseDir: string, value: string) => {
    const key = normalizeProjectKey(baseDir);
    const prefixes: Record<string, string> = {};
    for (const [dir, prefix] of Object.entries(navigation.projectPrefixes)) {
      if (normalizeProjectKey(dir) !== key) {
        prefixes[dir] = prefix;
      }
    }
    const prefix = sanitizePrefix(value);
    if (prefix) {
      prefixes[key] = prefix;
    }
    update({ projectPrefixes: prefixes });
  };

  return (
    <Section title={t('taskNavigation.settings.title')} className="px-4 py-5">
      <div className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-start gap-1">
            <Checkbox
              id="task-navigation-auto-summarize"
              checked={navigation.autoSummarize}
              onChange={(checked) => update({ autoSummarize: checked })}
              label={t('taskNavigation.settings.autoSummarize')}
            />
            <InfoIcon tooltip={t('taskNavigation.settings.autoSummarizeTooltip')} />
          </div>
          {navigation.autoSummarize && (
            <div className="ml-6 flex items-center gap-1">
              <div className="w-64 p-2 bg-bg-secondary-light border-2 border-border-default rounded focus-within:outline-none focus-within:border-border-light">
                <ModelSelectorWrapper
                  className="w-full justify-between"
                  selectedModelId={navigation.summaryModel}
                  onChange={(model: Model | null) => update({ summaryModel: model ? getProviderModelId(model) : null })}
                  labelOnNull={t('settings.tasks.inheritModel')}
                  skipPreferredModelsUpdate
                />
              </div>
              <InfoIcon tooltip={t('taskNavigation.settings.summaryModelTooltip')} />
            </div>
          )}
        </div>

        <div className="flex items-start gap-1">
          <Checkbox
            id="task-navigation-auto-regenerate-title"
            checked={navigation.autoRegenerateTitle}
            onChange={(checked) => update({ autoRegenerateTitle: checked })}
            label={t('taskNavigation.settings.autoRegenerateTitle')}
          />
          <InfoIcon tooltip={t('taskNavigation.settings.autoRegenerateTitleTooltip')} />
        </div>

        <div className="space-y-2">
          <div className="flex items-start gap-1">
            <Checkbox
              id="task-navigation-search-index"
              checked={navigation.searchIndexEnabled}
              onChange={(checked) => update({ searchIndexEnabled: checked })}
              label={t('taskNavigation.settings.searchIndexEnabled')}
            />
            <InfoIcon tooltip={t('taskNavigation.settings.searchIndexEnabledTooltip')} />
          </div>
          {navigation.searchIndexEnabled && (
            <div className="ml-6 flex items-start gap-1">
              <Checkbox
                id="task-navigation-concept-search"
                checked={navigation.conceptSearchEnabled}
                onChange={(checked) => update({ conceptSearchEnabled: checked })}
                label={t('taskNavigation.settings.conceptSearchEnabled')}
              />
              <InfoIcon tooltip={t('taskNavigation.settings.conceptSearchEnabledTooltip')} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="task-navigation-quick-switcher-count" className="text-xs text-text-primary">
            {t('taskNavigation.settings.quickSwitcherCount')}
          </label>
          <Input
            id="task-navigation-quick-switcher-count"
            type="number"
            min={3}
            max={20}
            size="sm"
            wrapperClassName="w-20"
            value={countText}
            onChange={(event) => handleCountChange(event.target.value)}
            onBlur={() => setCountText(String(navigation.quickSwitcherCount))}
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-text-primary">{t('taskNavigation.settings.quickSwitcherTopicCount')}</span>
          <div className="flex items-center rounded border border-border-default">
            <button
              type="button"
              aria-label={t('taskNavigation.settings.decrease')}
              disabled={navigation.quickSwitcherTopicCount <= 1}
              onClick={() => update({ quickSwitcherTopicCount: navigation.quickSwitcherTopicCount - 1 })}
              className="px-1.5 py-1 text-text-muted hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <MdRemove className="w-3.5 h-3.5" />
            </button>
            <span className="w-6 text-center text-xs text-text-primary">{navigation.quickSwitcherTopicCount}</span>
            <button
              type="button"
              aria-label={t('taskNavigation.settings.increase')}
              disabled={navigation.quickSwitcherTopicCount >= 4}
              onClick={() => update({ quickSwitcherTopicCount: navigation.quickSwitcherTopicCount + 1 })}
              className="px-1.5 py-1 text-text-muted hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <MdAdd className="w-3.5 h-3.5" />
            </button>
          </div>
          <InfoIcon tooltip={t('taskNavigation.settings.quickSwitcherTopicCountTooltip')} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-text-primary">{t('taskNavigation.settings.projectPrefixes')}</span>
            <InfoIcon tooltip={t('taskNavigation.settings.projectPrefixesTooltip')} />
          </div>
          {projectDirs.length === 0 ? (
            <div className="text-2xs text-text-muted">{t('taskNavigation.settings.noOpenProjects')}</div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-x-3 gap-y-1.5 max-w-md">
              {projectDirs.map((baseDir) => (
                <Fragment key={baseDir}>
                  <span className="truncate text-xs text-text-secondary" title={baseDir}>
                    {getProjectName(baseDir)}
                  </span>
                  <Input
                    size="sm"
                    value={getPrefixOverride(baseDir)}
                    placeholder={deriveProjectPrefix(baseDir)}
                    onChange={(event) => handlePrefixChange(baseDir, event.target.value)}
                  />
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
};
