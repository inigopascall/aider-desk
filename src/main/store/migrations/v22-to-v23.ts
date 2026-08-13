/**
 * Replaces the combined performance-mode setting with a visual-animation-only
 * preference. Streaming remains permanently coalesced at the built-in rate.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const migrateSettingsV22toV23 = (settings: any) => {
  const disableCssStreamingAnimations = settings.disableCssStreamingAnimations ?? settings.performanceMode ?? true;

  const { performanceMode: _performanceMode, streamFlushIntervalMs: _streamFlushIntervalMs, ...migratedSettings } = settings;

  return {
    ...migratedSettings,
    disableCssStreamingAnimations,
  };
};
