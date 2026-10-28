export interface RepositoryMappingsPathRule {
  /** Local path prefix, e.g. `~/code/iwd/` or an absolute path. */
  from: string;
  /** Replacement prefix used inside the command template. */
  to: string;
}

export interface RepositoryMappingsSettings {
  /** Regenerate the built-in mappings in the background when a prompt finishes and when a project opens. */
  autoRegenerate: boolean;
  /** Generate the codebase outline (`outline.md`). */
  outlineEnabled: boolean;
  /** Folder rules that collapse or exclude paths from the outline. */
  outlineRules: string[];
  /** Give each outline directory a one-line description, written by the topic map model. */
  outlineDescriptions: boolean;
  /** Token budget for the outline. Over it, the largest directories show their description without their file names. */
  outlineMaxTokens: number;
  /** Generate `schema.md`, `models.md` and `routes.md` for Laravel projects. */
  laravelEnabled: boolean;
  /** Shell command that runs PHP for a project. `{projectDir}` is the project path after the path rules; `{command}` is the PHP invocation. */
  laravelCommandTemplate: string;
  /** Prefix replacements that turn the local project path into `{projectDir}`. The first matching rule wins. */
  laravelPathRules: RepositoryMappingsPathRule[];
  /** Optional shell command run before each Laravel export, e.g. to wait for file sync. Accepts `{projectDir}` and `{localProjectDir}`. */
  laravelPreExportCommand: string;
  /** Time limit for the pre-export command and the export together. */
  laravelTimeoutSeconds: number;
  /** Most tokens of mapping content sent with a request. A file that does not fit is left out whole, never cut. */
  maxTokens: number;
}

export const DEFAULT_REPOSITORY_MAPPINGS_SETTINGS: RepositoryMappingsSettings = {
  autoRegenerate: true,
  outlineEnabled: true,
  outlineRules: [],
  outlineDescriptions: true,
  outlineMaxTokens: 12000,
  laravelEnabled: true,
  laravelCommandTemplate: 'cd {projectDir} && {command}',
  laravelPathRules: [],
  laravelPreExportCommand: '',
  laravelTimeoutSeconds: 180,
  maxTokens: 40000,
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

export const getRepositoryMappingsSettings = (settings?: { repositoryMappings?: Partial<RepositoryMappingsSettings> } | null): RepositoryMappingsSettings => {
  const configured = settings?.repositoryMappings ?? {};
  const defaults = DEFAULT_REPOSITORY_MAPPINGS_SETTINGS;
  const template = stringOr(configured.laravelCommandTemplate, defaults.laravelCommandTemplate);
  return {
    autoRegenerate: configured.autoRegenerate ?? defaults.autoRegenerate,
    outlineEnabled: configured.outlineEnabled ?? defaults.outlineEnabled,
    outlineRules: Array.isArray(configured.outlineRules)
      ? configured.outlineRules
          .filter((rule): rule is string => typeof rule === 'string')
          .map((rule) => rule.trim())
          .filter((rule) => rule && !rule.startsWith('#'))
      : [],
    outlineDescriptions: configured.outlineDescriptions ?? defaults.outlineDescriptions,
    outlineMaxTokens: clampNumber(configured.outlineMaxTokens, defaults.outlineMaxTokens, 1000, 100000),
    laravelEnabled: configured.laravelEnabled ?? defaults.laravelEnabled,
    laravelCommandTemplate: template.trim() ? template : defaults.laravelCommandTemplate,
    laravelPathRules: Array.isArray(configured.laravelPathRules)
      ? configured.laravelPathRules
          .filter((rule) => rule && typeof rule.from === 'string' && rule.from.trim() && typeof rule.to === 'string')
          .map((rule) => ({ from: rule.from, to: rule.to }))
      : [],
    laravelPreExportCommand: stringOr(configured.laravelPreExportCommand, defaults.laravelPreExportCommand),
    laravelTimeoutSeconds: clampNumber(configured.laravelTimeoutSeconds, defaults.laravelTimeoutSeconds, 10, 1800),
    maxTokens: clampNumber(configured.maxTokens, defaults.maxTokens, 1000, 500000),
  };
};

/** `fresh`: written by the last run. `stale`: kept from an earlier run because the latest attempt failed. */
export type RepositoryMappingFileStatus = 'fresh' | 'stale';

export interface RepositoryMappingFileState {
  status: RepositoryMappingFileStatus;
  /** Why the file is stale. */
  message?: string;
  generatedAt?: string;
}

export interface RepositoryMappingGeneratorState {
  /** Fingerprint of the inputs the files were last generated from. */
  fingerprint?: string;
  /** Fingerprint of the inputs of the last attempt, successful or not. */
  attemptedFingerprint?: string;
  attemptedAt?: string;
  lastFailureAt?: string;
  /** A problem with the generator as a whole, e.g. it could not run at all. */
  message?: string;
  /** Keyed by the file's path relative to the project, with forward slashes. */
  files: Record<string, RepositoryMappingFileState>;
}

export interface RepositoryMappingsState {
  version: 1;
  generators: Record<string, RepositoryMappingGeneratorState>;
}
