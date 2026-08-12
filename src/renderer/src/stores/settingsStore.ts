import { useCallback } from 'react';
import { createWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/vanilla/shallow';
import { devtools } from 'zustand/middleware';
import { Font, SettingsData, Theme } from '@common/types';

import { useApi } from '@/contexts/ApiContext';
import { setStreamConfig } from '@/api/stream-config';

interface SettingsState {
  settings: SettingsData | null;
  theme: Theme | null;
  font: Font | null;
  fontSize: number | null;
  readonlyExtensionUi: boolean | null;
}

interface SettingsActions {
  setSettingsState: (settings: SettingsData) => void;
  setThemeValue: (theme: Theme) => void;
  setFontValue: (font: Font) => void;
  setFontSizeValue: (fontSize: number) => void;
}

type SettingsStore = SettingsState & SettingsActions;

const DEVTOOLS_OPTIONS = {
  name: 'SettingsStore',
  enabled: import.meta.env.DEV,
  serialize: {
    options: {
      map: true,
      set: true,
    },
  },
};

export const useSettingsStore = createWithEqualityFn<SettingsStore>()(
  devtools(
    (set) => ({
      settings: null,
      theme: null,
      font: null,
      fontSize: null,
      readonlyExtensionUi: null,
      setSettingsState: (newSettings) => {
        // Push stream config to the BrowserApi so it can re-subscribe with the
        // correct coalescing mode and flush interval. Also toggle the
        // `performance-mode` CSS class on <body> — this is the single guaranteed
        // choke point for the class (mirrors `snapshot-mode-active`).
        const performanceMode = newSettings.performanceMode ?? true;
        setStreamConfig({
          streamMode: performanceMode ? 'coalesced' : 'live',
          streamFlushIntervalMs: newSettings.streamFlushIntervalMs ?? 2500,
        });
        document.body.classList.toggle('performance-mode', performanceMode);
        set({
          settings: newSettings,
          theme: newSettings.theme ?? null,
          font: newSettings.font ?? null,
          fontSize: newSettings.fontSize ?? null,
        });
      },
      setThemeValue: (theme) => set({ theme }),
      setFontValue: (font) => set({ font }),
      setFontSizeValue: (fontSize) => set({ fontSize }),
    }),
    DEVTOOLS_OPTIONS,
  ),
  shallow,
);

export const useSaveSettings = () => {
  const api = useApi();
  return useCallback(
    async (settings: SettingsData) => {
      try {
        useSettingsStore.getState().setSettingsState(settings);
        const updatedSettings = await api.saveSettings(settings);
        useSettingsStore.getState().setSettingsState(updatedSettings);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to save settings:', error);
      }
    },
    [api],
  );
};

export const setTheme = (theme: Theme) => useSettingsStore.getState().setThemeValue(theme);

export const setFont = (font: Font) => useSettingsStore.getState().setFontValue(font);

export const setFontSize = (fontSize: number) => useSettingsStore.getState().setFontSizeValue(fontSize);
