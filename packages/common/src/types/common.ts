import {
  AnthropicProvider,
  BedrockProvider,
  DeepseekProvider,
  GeminiProvider,
  GroqProvider,
  LlmProvider,
  LmStudioProvider,
  MinimaxProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  OpenCodeProvider,
  OpenCodeGoProvider,
  OpenRouterProvider,
  RequestyProvider,
  VertexAiProvider,
  SyntheticProvider,
} from '@common/agent';
import { z } from 'zod';

import { ContextFile, ContextMemoryMode, ContextMessage, PromptContext, UsageReportData } from './context';

// Worktree schema definition
export const WorktreeSchema = z.object({
  path: z.string(),
  baseBranch: z.string().optional(),
  baseCommit: z.string().optional(),
  branch: z.string().optional(),
  pendingRebaseFromBranch: z.string().optional(),
  prunable: z.boolean().optional(),
});

export type Worktree = z.infer<typeof WorktreeSchema>;

// Merge state for tracking merge operations and enabling revert
export const MergeStateSchema = z.object({
  beforeMergeCommitHash: z.string(),
  worktreeBranchCommitHash: z.string(),
  mainOriginalStashId: z.string().optional(),
  targetBranch: z.string().optional(),
  checkoutless: z.boolean().optional(),
  timestamp: z.number(),
});

export type MergeState = z.infer<typeof MergeStateSchema>;

export interface GitAheadCommits {
  count: number;
  commits: string[];
}

export interface GitSyncCommits {
  outgoing: GitAheadCommits;
  incoming: GitAheadCommits;
}

export interface UncommittedFiles {
  count: number;
  files: string[];
}

export interface RebaseState {
  inProgress: boolean;
  hasUnmergedPaths: boolean;
  unmergedFiles?: string[];
}

export interface ConflictResolutionFileContext {
  filePath: string;
  base?: string | null;
  ours?: string | null;
  theirs?: string | null;
  current?: string;
}

export interface TaskGitWorktreeStatus {
  baseBranch: string;
  targetBranch: string;
  aheadCommits: GitAheadCommits;
  predictedConflicts: {
    hasConflicts: boolean;
    conflictingFiles?: string[];
    conflictingCommits?: {
      ours: string[];
      theirs: string[];
    };
    canAutoMerge?: boolean;
  };
}

export interface TaskGitStatus {
  currentBranch: string;
  uncommittedFiles: UncommittedFiles;
  rebaseState: RebaseState;
  worktree?: TaskGitWorktreeStatus;
}

export interface TaskGitStatusUpdatedData {
  baseDir: string;
  taskId: string;
  status: TaskGitStatus | null;
}

export interface ModeDefinition {
  name: Mode;
  label: string;
  description?: string;
  /** Full react-icons component name including pack prefix (e.g., 'FiTerminal', 'GoCodeReview') */
  icon?: string;
}

export type Mode = string;

export const AIDER_MODES: Mode[] = ['code', 'ask', 'architect', 'context'];

export const AIDER_COMMANDS: string[] = ['commit', 'map', 'map-refresh', 'tokens', 'test'];

/** Per-agent model assignment for a workflow. Model ids are "provider/model". Undefined = agent profile default. */
export interface WorkflowAgentModels {
  primary?: string;
  fallback?: string;
}

/** Persisted per-workflow configuration set via the workflow configuration modal. */
export interface WorkflowConfig {
  /** Keyed by agent role name (e.g. "DIGESTER"). */
  agentModels: Record<string, WorkflowAgentModels>;
  /** Optional shell command run in the task directory before the review stage; its output is passed to the reviewer. */
  preArbiterCommand?: string;
  /** Optional shell command run in the task directory before the workflow's final git commit. */
  bashCommand?: string;
  /** Per-role enabled flags for optional agents. Absent or false values mean the optional agent is disabled. */
  enabledAgents?: Record<string, boolean>;
  /**
   * Per-role persist-primary flags. When true, the role's primary model is
   * retried with backoff before falling back to the fallback model. Roles
   * without an explicit value fall back to `WORKFLOW_PERSIST_PRIMARY_DEFAULT_ROLES`.
   */
  persistPrimary?: Record<string, boolean>;
  /** Maximum number of parallel editor agents. Zero or absent means unlimited. */
  parallelEditors?: number;
}

/** Zod schema for per-agent model assignment in a workflow. Model ids are "provider/model". Undefined = agent profile default. */
export const WorkflowAgentModelsSchema = z.object({
  primary: z.string().optional(),
  fallback: z.string().optional(),
});

/** Zod schema for persisted per-workflow configuration set via the workflow configuration modal. */
export const WorkflowConfigSchema = z.object({
  /** Keyed by agent role name (e.g. "DIGESTER"). */
  agentModels: z.record(z.string(), WorkflowAgentModelsSchema),
  /** Optional shell command run in the task directory before the review stage; its output is passed to the reviewer. */
  preArbiterCommand: z.string().optional(),
  /** Optional shell command run in the task directory before the workflow's final git commit. */
  bashCommand: z.string().optional(),
  /** Per-role enabled flags for optional agents. Absent or false values mean the optional agent is disabled. */
  enabledAgents: z.record(z.string(), z.boolean()).optional(),
  /** Per-role persist-primary flags. When true, the role's primary model is retried with backoff before falling back to the fallback model. */
  persistPrimary: z.record(z.string(), z.boolean()).optional(),
  /** Maximum number of parallel editor agents. Zero or absent means unlimited. */
  parallelEditors: z.number().optional(),
});

/**
 * Ordered agent roles per workflow id. Every role here is a configurable model
 * role: the workflow configuration modal exposes primary/fallback model
 * selectors for each. Only roles listed in `WORKFLOW_OPTIONAL_AGENT_ROLES`
 * additionally receive a run toggle; all other roles always run.
 */
export const WORKFLOW_AGENT_ROLES: Record<string, string[]> = {
  'dev-pipeline': ['DIGESTER', 'INVESTIGATOR', 'RESEARCHER', 'GRAND-PLANNER', 'DECOMPOSITOR', 'EDITOR', 'CONFIRMER'],
  'dev-pipeline-review': [
    'DIGESTER',
    'INVESTIGATOR',
    'RESEARCHER',
    'GRAND-PLANNER',
    'DECOMPOSITOR',
    'EDITOR',
    'REVIEWER-1',
    'REVIEWER-2',
    'ARBITER',
    'CONFIRMER',
  ],
};

/** Reviewer agent roles for the review workflow, ordered after EDITOR. */
export const WORKFLOW_REVIEWER_ROLES = ['REVIEWER-1', 'REVIEWER-2'];

/** Arbiter agent role for the review workflow. */
export const WORKFLOW_ARBITER_ROLE = 'ARBITER';

/**
 * Optional agent roles per workflow id; these are the only roles that can be
 * toggled via `enabledAgents`. Roles absent from this list (e.g. CONFIRMER)
 * always run and are never controlled by `enabledAgents`.
 */
export const WORKFLOW_OPTIONAL_AGENT_ROLES: Record<string, string[]> = {
  'dev-pipeline-review': [...WORKFLOW_REVIEWER_ROLES, WORKFLOW_ARBITER_ROLE],
};

/**
 * Returns true only when the given role is explicitly enabled in the workflow
 * configuration's `enabledAgents` record. Absent configuration, absent records,
 * and absent or false flags all mean the optional agent is disabled.
 */
export const isWorkflowAgentEnabled = (config: WorkflowConfig | undefined, role: string): boolean =>
  config?.enabledAgents?.[role] === true;

/**
 * Roles that default to persist-primary behavior (primary-model backoff before
 * falling back to the fallback model) when no explicit `persistPrimary` flag is
 * stored for them in the workflow configuration.
 */
export const WORKFLOW_PERSIST_PRIMARY_DEFAULT_ROLES = ['GRAND-PLANNER', 'ARBITER'];

/**
 * Returns whether the given role should persist with its primary model (backing
 * off) before falling back to the fallback model. An explicitly stored value in
 * the configuration's `persistPrimary` record wins; otherwise the role defaults
 * to enabled when listed in `WORKFLOW_PERSIST_PRIMARY_DEFAULT_ROLES`.
 */
export const isWorkflowPersistPrimaryEnabled = (config: WorkflowConfig | undefined, role: string): boolean => {
  const stored = config?.persistPrimary?.[role];
  if (stored !== undefined) return stored;
  return WORKFLOW_PERSIST_PRIMARY_DEFAULT_ROLES.includes(role);
};

/** Fallback dot colour for workflows with no explicit identity colour. */
export const DEFAULT_WORKFLOW_COLOR = '#8A8A8A';

/** Hard-coded identity colour per workflow id, used for the dot in the workflow selector. */
export const WORKFLOW_COLORS: Record<string, string> = {
  'dev-pipeline': '#F8E61B',
  'dev-pipeline-review': '#7ED321',
};

export const getWorkflowColor = (workflowId: string): string => WORKFLOW_COLORS[workflowId] ?? DEFAULT_WORKFLOW_COLOR;

export interface WorkflowInfo {
  id: string;
  name: string;
  agents: string[];
  /** Identity colour shown as a dot in the workflow selector. */
  color?: string;
}

export const AVAILABLE_WORKFLOWS: WorkflowInfo[] = [
  {
    id: 'dev-pipeline',
    name: 'Dev Pipeline',
    agents: WORKFLOW_AGENT_ROLES['dev-pipeline'],
    color: WORKFLOW_COLORS['dev-pipeline'],
  },
  {
    id: 'dev-pipeline-review',
    name: 'Dev Pipeline + Review',
    agents: WORKFLOW_AGENT_ROLES['dev-pipeline-review'],
    color: WORKFLOW_COLORS['dev-pipeline-review'],
  },
];

export enum AutonomyMode {
  Manual = 'manual',
  Guided = 'guided',
  Autonomous = 'autonomous',
}

export const DEFAULT_AUTONOMY_MODE = AutonomyMode.Guided;

export enum TaskExecutionMode {
  CreateOnly = 'create_only',
  WaitForFinish = 'wait_for_finish',
  RunInBackground = 'run_in_background',
}

export interface AiderRunOptions {
  autoApprove?: boolean;
  denyCommands?: boolean;
}

export type EditFormat = 'diff' | 'diff-fenced' | 'whole' | 'udiff' | 'udiff-simple' | 'patch';

export enum DiffViewMode {
  SideBySide = 'side-by-side',
  Unified = 'unified',
  Compact = 'compact',
}

export enum UpdatedFilesGroupMode {
  Grouped = 'grouped',
  Flat = 'flat',
}

export enum MessageViewMode {
  Full = 'full',
  Compact = 'compact',
}

export enum ReasoningEffort {
  Max = 'max',
  XHigh = 'xhigh',
  High = 'high',
  Medium = 'medium',
  Low = 'low',
  Minimal = 'minimal',
  None = 'none',
}

/**
 * Portable reasoning level for AI SDK v7's top-level `reasoning` parameter.
 * See https://ai-sdk.dev/docs/ai-sdk-core/reasoning
 */
export type Reasoning = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Timeout configuration for model calls.
 * See https://ai-sdk.dev/docs/ai-sdk-core/settings#timeout
 */
export interface ModelCallTimeout {
  /** Total timeout for the entire call including all steps. */
  totalMs?: number;
  /** Timeout for each individual step (LLM call). */
  stepMs?: number;
  /** Timeout between stream chunks (streaming only). Aborts if no chunk received in time. */
  chunkMs?: number;
  /** Default timeout for all tool executions. */
  toolMs?: number;
  /** Per-tool timeout overrides (e.g. `{ weatherMs: 3000 }`). Takes precedence over `toolMs`. */
  tools?: Record<string, number>;
}

/**
 * Model call settings that map to AI SDK Language Model Call Options and Request Options.
 * These override provider-derived defaults when set via extension events.
 *
 * See https://ai-sdk.dev/docs/ai-sdk-core/settings for details.
 */
export interface ModelCallSettings {
  // Language Model Call Options

  /** Maximum number of tokens to generate. */
  maxOutputTokens?: number;
  /** Temperature setting (0 = deterministic, higher = more random). */
  temperature?: number;
  /** Nucleus sampling. Recommended instead of temperature, not alongside. */
  topP?: number;
  /** Only sample from top K options for each subsequent token. */
  topK?: number;
  /** Penalty for tokens already present in the prompt. */
  presencePenalty?: number;
  /** Penalty for repeatedly using the same words/phrases. */
  frequencyPenalty?: number;
  /** Stop sequences for text generation. */
  stopSequences?: string[];
  /** Random seed for deterministic results. */
  seed?: number;
  /** Controls reasoning/thinking behavior. See https://ai-sdk.dev/docs/ai-sdk-core/reasoning */
  reasoning?: Reasoning;

  // Request Options

  /** Maximum number of retries. Set to 0 to disable retries. Default: 2. */
  maxRetries?: number;
  /** Abort signal that can be used to cancel the call. */
  abortSignal?: AbortSignal;
  /** Timeout for the call. Can be a number (ms) or a detailed timeout configuration. */
  timeout?: number | ModelCallTimeout;
  /** Additional HTTP headers to send with the request. */
  headers?: Record<string, string>;
}

export interface ResponseChunkData {
  messageId: string;
  baseDir: string;
  taskId: string;
  chunk: string;
  reasoning?: string;
  reflectedMessage?: string;
  promptContext?: PromptContext;
}

export interface ToolInputChunkData {
  baseDir: string;
  taskId: string;
  toolCallId: string;
  serverName?: string;
  toolName?: string;
  partialArgs?: unknown;
  isComplete: boolean;
  promptContext?: PromptContext;
}

export interface ResponseCompletedData {
  type: 'response-completed';
  messageId: string;
  baseDir: string;
  taskId: string;
  content: string;
  reasoning?: string;
  reflectedMessage?: string;
  editedFiles?: string[];
  commitHash?: string;
  commitMessage?: string;
  diff?: string;
  usageReport?: UsageReportData;
  sequenceNumber?: number;
  promptContext?: PromptContext;
  timestamp?: number;
}

export interface CommandOutputData {
  baseDir: string;
  taskId: string;
  command: string;
  output: string;
  timestamp?: number;
}

export type LogLevel = 'info' | 'warning' | 'error' | 'loading';

export interface LogData {
  baseDir: string;
  taskId: string;
  level: LogLevel;
  message?: string;
  finished?: boolean;
  promptContext?: PromptContext;
  actionIds?: string[];
  timestamp?: number;
}

/** Identifies a single execution of a workflow within a task. */
export interface WorkflowRunInfo {
  runId: string;
  workflowId: string;
  workflowName: string;
}

/**
 * A durable workflow progress event. It is task history metadata and is never
 * included in LLM context or connector conversation messages.
 */
export interface WorkflowLogData extends WorkflowRunInfo {
  id: string;
  baseDir: string;
  taskId: string;
  level: LogLevel;
  message: string;
  finished?: boolean;
  promptContext?: PromptContext;
  actionIds?: string[];
  timestamp: number;
  /** Monotonic per-task ordinal; authoritative ordering key. */
  sequence: number;
}

export interface WorkflowLogsStateData {
  hasWorkflowHistory: boolean;
  logs: WorkflowLogData[];
}

// System log types (for application-wide logging)
export type SystemLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SystemLogEntry {
  id?: number;
  timestamp: string;
  level: SystemLogLevel;
  message: string;
  extension?: string; // Extension name if log is from an extension
  metadata?: Record<string, unknown>; // Additional metadata from winston
}

export interface SystemLogsResponse {
  logs: SystemLogEntry[];
  hasMore: boolean;
}

export interface SystemLogData {
  entry: SystemLogEntry;
}

export interface ToolData {
  type: 'tool';
  baseDir: string;
  taskId: string;
  id: string;
  serverName: string;
  toolName: string;
  args?: unknown;
  response?: string;
  usageReport?: UsageReportData;
  promptContext?: PromptContext;
  finished?: boolean;
  timestamp?: number;
}

export interface ContextFilesUpdatedData {
  baseDir: string;
  taskId: string;
  files: ContextFile[];
}

export interface RepositoryMappingsUpdatedData {
  baseDir: string;
  files: ContextFile[];
}

export interface RegenerateRepositoryMappingsResult {
  success: boolean;
  error?: string;
}

export interface UpdatedFile {
  path: string;
  additions: number;
  deletions: number;
  diff?: string;
  commitHash?: string;
  commitMessage?: string;
  hasConflicts?: boolean;
  isUntracked?: boolean;
}

export interface UpdatedFilesUpdatedData {
  baseDir: string;
  taskId: string;
  taskDir: string;
  files: UpdatedFile[];
}

export interface CommandsData {
  baseDir: string;
  customCommands: Command[];
  extensionCommands: Command[];
}

export interface AutocompletionData {
  baseDir: string;
  taskId: string;
  words?: string[];
  allFiles?: string[];
}

export interface Answer {
  text: string;
  shortkey: string;
}

export interface QuestionData {
  baseDir: string;
  taskId: string;
  text: string;
  subject?: string;
  isGroupQuestion?: boolean;
  answers?: Answer[];
  defaultAnswer: string;
  internal?: boolean;
  key?: string;
}

export interface QuestionAnsweredData {
  baseDir: string;
  taskId: string;
  question: QuestionData;
  answer: string;
  userInput?: string;
}

export interface QueuedPromptData {
  id: string;
  text: string;
  mode: Mode;
  timestamp: number;
  images?: string[];
  customCommand?: {
    name: string;
    args: string[];
    images?: string[];
  };
}

export interface QueuedPromptsUpdatedData {
  baseDir: string;
  taskId: string;
  queuedPrompts: QueuedPromptData[];
}

export type ContextFileSourceType = 'companion' | 'aider' | 'app' | string;

export enum OS {
  Windows = 'windows',
  Linux = 'linux',
  MacOS = 'macos',
}

export interface CloudflareTunnelStatus {
  isRunning: boolean;
  url?: string;
}

export interface WindowState {
  width: number;
  height: number;
  x: number | undefined;
  y: number | undefined;
  isMaximized: boolean;
}

export const ProjectSettingsSchema = z.object({
  // @deprecated: These properties are deprecated in favor of task-level settings
  // They are kept for backward compatibility and as defaults for new tasks
  mainModel: z.string(),
  weakModel: z.string().nullable().optional(),
  architectModel: z.string().nullable().optional(),
  agentProfileId: z.string(),
  modelEditFormats: z.record(z.string(), z.enum(['diff', 'diff-fenced', 'whole', 'udiff', 'udiff-simple', 'patch'])),
  reasoningEffort: z.string().optional(),
  thinkingTokens: z.string().optional(),
  currentMode: z.string(),
  weakModelLocked: z.boolean().optional(),
  autonomyModeLocked: z.boolean().optional(),
  updatedFilesGroupMode: z.enum(['grouped', 'flat']).default('flat'),
  disabledRuleFiles: z.array(z.string()).default([]),
  disabledRepositoryMappingFiles: z.array(z.string()).default([]),
  disabledSkills: z.array(z.string()).default([]),
  contextSidebarSectionsOrder: z.array(z.string()).default([]),
  contextSidebarSectionsHidden: z.array(z.string()).default([]),
  enabledWorkflows: z.array(z.string()).optional(),
  workflowConfigs: z.record(z.string(), WorkflowConfigSchema).optional(),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export interface ProjectData {
  active: boolean;
  baseDir: string;
  settings: ProjectSettings;
}

export interface ReadonlyProjectData {
  active: boolean;
  baseDir: string;
  name: string;
}

export interface ReadonlyDisplaySettings {
  language: string;
  theme: Theme;
  font: Font;
  fontSize: number;
  renderMarkdown: boolean;
  fullMessageRendering: boolean;
  messageViewMode?: MessageViewMode;
  showMessageMap?: boolean;
  enableExtensionUi: boolean;
}

export interface ReadonlyBootstrap {
  mode: 'readonly';
  projects: ReadonlyProjectData[];
  display: ReadonlyDisplaySettings;
}

export interface StandardBootstrap {
  mode: 'standard';
}

export type BrowserBootstrap = ReadonlyBootstrap | StandardBootstrap;

export interface RawModelInfo {
  max_input_tokens: number;
  max_output_tokens: number;
  input_cost_per_token: number;
  output_cost_per_token: number;
  supports_function_calling: boolean;
  supports_tool_choice: boolean;
  litellm_provider: string;
}

export interface ModelsData {
  baseDir: string;
  taskId: string;
  mainModel: string;
  weakModel?: string | null;
  architectModel?: string | null;
  reasoningEffort?: string;
  thinkingTokens?: string;
  editFormat?: EditFormat;
  info?: RawModelInfo;
  error?: string;
}

export enum ToolApprovalState {
  Always = 'always',
  Never = 'never',
  Ask = 'ask',
}

export enum ProjectStartMode {
  Empty = 'empty',
  Last = 'last',
  Remote = 'remote',
}

export enum SuggestionMode {
  Automatically = 'automatically',
  OnTab = 'onTab',
  MentionAtSign = 'mentionAtSign',
}

export interface PromptBehavior {
  suggestionMode: SuggestionMode;
  suggestionDelay: number;
  requireCommandConfirmation: {
    add: boolean;
    readOnly: boolean;
    model: boolean;
    modeSwitching: boolean;
  };
  useVimBindings: boolean;
  openEditorAtFullWidth?: boolean;
  submitOnEnter?: boolean; // true = Enter submits; false (default) = Shift+Enter submits
}

export enum InvocationMode {
  /** Subagent is only used when explicitly requested by the user. */
  OnDemand = 'on-demand',
  /** Subagent can be automatically invoked when appropriate by the agent. */
  Automatic = 'automatic',
}

export interface SubagentConfig {
  enabled: boolean;
  contextMemory: ContextMemoryMode;
  systemPrompt: string;
  invocationMode: InvocationMode;
  color: string;
  description: string;
}

/**
 * The four markdown sidecar files that canonically store agent prompt content.
 * Each agent directory contains one sidecar per prompt field; the loader
 * hydrates these into the in-memory AgentProfile at read time.
 */
export const PROMPT_SIDECAR_FILES = [
  'customInstructions.md',
  'systemPrompt.md',
  'subagent.systemPrompt.md',
  'subagent.description.md',
] as const;

/** A validated filename from the prompt sidecar whitelist. */
export type PromptSidecarFilename = (typeof PROMPT_SIDECAR_FILES)[number];

export interface BashToolSettings {
  allowedPattern: string;
  deniedPattern: string;
}

export type ToolSettings = BashToolSettings;

export interface AgentProfile {
  id: string;
  projectDir?: string; // If specified, it's a project-level profile, otherwise global
  workflowAgent?: boolean; // true = belongs to the Workflow Agents tier (stored in ~/.aider-desk/workflow-agents); excluded from normal agent/subagent lists; usable only within Workflows
  name: string;
  provider: string;
  model: string;
  maxIterations: number;
  maxTokens?: number; // overrides model maxOutputTokens when set
  minTimeBetweenToolCalls: number; // in milliseconds
  temperature?: number; // overrides model temperature when set
  reasoning?: Reasoning; // portable reasoning level for this agent; undefined = provider default
  enabledServers: string[];
  toolApprovals: Record<string, ToolApprovalState>;
  toolSettings: Record<string, ToolSettings>;
  includeContextFiles: boolean;
  /** Include generated read-only repository mapping files before normal context files. */
  includeRepoMappings: boolean;
  usePowerTools: boolean;
  useAiderTools: boolean;
  useTodoTools: boolean;
  useSubagents: boolean;
  useTaskTools: boolean;
  useMemoryTools: boolean;
  useSkillsTools: boolean;
  useAgentMemoryScope?: boolean; // when true, memory tools use a per-agent scope instead of the project directory
  useExtensionTools: boolean;
  disabledExtensionTools: string[]; // Array of extension IDs whose tools are disabled
  customInstructions: string;
  systemPrompt?: string; // when set, overrides the default built-in system prompt when the profile runs as the main agent; used as fallback for subagent runs when subagent.systemPrompt is not set
  enabledSubagentIds?: string[]; // profile IDs allowed to be used as subagents; undefined = all subagents allowed
  subagent: SubagentConfig;
  isSubagent?: boolean; // flag to indicate if this profile is being used as a subagent
  ruleFiles?: string[]; // Array of absolute paths to rule files for this agent profile
  autoCompactThresholdPercentage?: number; // overrides global auto-compact threshold percentage when set
  autoCompactThresholdTokens?: number; // overrides global auto-compact threshold tokens when set
  autoCompactionType?: ContextCompactionType; // overrides global compaction type when set
}

export interface EnvironmentVariable {
  value: string;
  source: string;
}

export const THEMES = [
  'dark',
  'light',
  'charcoal',
  'neon',
  'neopunk',
  'aurora',
  'ocean',
  'forest',
  'lavender',
  'bw',
  'midnight',
  'serenity',
  'cappuccino',
  'fresh',
  'botanical-garden',
  'botanical-garden-dark',
  'obsidian',
  'crimson',
] as const;
export type Theme = (typeof THEMES)[number];

export const isCodeEditorDarkTheme = (theme: Theme) =>
  [
    'aurora',
    'botanical-garden',
    'botanical-garden-dark',
    'charcoal',
    'dark',
    'forest',
    'lavender',
    'midnight',
    'neon',
    'neopunk',
    'ocean',
    'obsidian',
    'crimson',
  ].includes(theme);

export const FONTS = [
  'Sono',
  'Poppins',
  'Nunito',
  'Quicksand',
  'PlayfairDisplay',
  'Lora',
  'SpaceGrotesk',
  'Orbitron',
  'Enriqueta',
  'FunnelDisplay',
  'GoogleSansCode',
  'Inter',
  'JetBrainsMono',
  'RobotoMono',
  'Sansation',
  'Silkscreen',
  'SourceCodePro',
  'SpaceMono',
  'UbuntuMono',
] as const;
export type Font = (typeof FONTS)[number];

export interface HotkeyConfig {
  projectHotkeys: {
    closeProject: string;
    newProject: string;
    usageDashboard: string;
    modelLibrary: string;
    settings: string;
    cycleNextProject: string;
    cyclePrevProject: string;
    openEditor: string;
    switchProject1: string;
    switchProject2: string;
    switchProject3: string;
    switchProject4: string;
    switchProject5: string;
    switchProject6: string;
    switchProject7: string;
    switchProject8: string;
    switchProject9: string;
  };
  taskHotkeys: {
    switchTask1: string;
    switchTask2: string;
    switchTask3: string;
    switchTask4: string;
    switchTask5: string;
    switchTask6: string;
    switchTask7: string;
    switchTask8: string;
    switchTask9: string;
    focusPrompt: string;
    newTask: string;
    closeTask: string;
    toggleMarkdownEditor: string;
    toggleMarkdownEditorMode: string;
    toggleMarkdownEditorWidth: string;
  };
  gitHotkeys: {
    pull: string;
    push: string;
    branches: string;
    newBranch: string;
    renameBranch: string;
    worktreeMerge: string;
    worktreeSquash: string;
    worktreeApplyUncommitted: string;
    worktreeRebase: string;
    worktreeAbortRebase: string;
    worktreeContinueRebase: string;
    worktreeResolveConflicts: string;
  };
  dialogHotkeys: {
    browseFolder: string;
    commandPalette: string;
  };
}

export enum MemoryEmbeddingProvider {
  SentenceTransformers = 'sentence-transformers',
}

export enum ContextCompactionType {
  Compact = 'compact',
  Handoff = 'handoff',
  Smart = 'smart',
}

export enum FileWatchMode {
  Auto = 'auto',
  Native = 'native',
  Polling = 'polling',
}

export interface TaskSettings {
  smartTaskState: boolean;
  autoGenerateTaskName: boolean;
  showTaskStateActions: boolean;
  /** Allow a third tier of tasks: a subtask may itself have subtasks. */
  allowSubSubTasks: boolean;
  worktreeSymlinkFolders: string[];
  worktreePostCreateCommand?: string;
  contextCompactingThreshold: { percentage: number; tokens: number };
  contextCompactionType: ContextCompactionType;
  taskNameModel?: string | null;
  taskStateModel?: string | null;
  commitMessageModel?: string | null;
  defaultWorkingMode: WorkingMode;
  defaultTaskMode?: Mode | 'last';
  defaultProjectMode?: Mode;
  worktreeBranchPrefix: string;
  renameBranchOnNameGeneration: boolean;
}

export interface MemoryConfig {
  enabled: boolean;
  provider: MemoryEmbeddingProvider;
  model: string;
  maxDistance: number;
}

export interface ExtensionsConfig {
  repositories: string[];
  disabled: string[];
}

export enum MemoryEmbeddingProgressPhase {
  Idle = 'idle',
  LoadingModel = 'loading-model',
  ReEmbedding = 're-embedding',
  Done = 'done',
  Error = 'error',
}

export interface MemoryEmbeddingProgress {
  phase: MemoryEmbeddingProgressPhase;
  status: string | null;
  done: number;
  total: number;
  finished: boolean;
  error?: string;
}

export interface SettingsData {
  onboardingFinished?: boolean;
  language: string;
  startupMode?: ProjectStartMode;
  zoomLevel?: number;
  notificationsEnabled?: boolean;
  theme?: Theme;
  font?: Font;
  fontSize?: number;
  renderMarkdown: boolean;
  fullMessageRendering: boolean;
  disableCssStreamingAnimations?: boolean;
  aiderDeskAutoUpdate: boolean;
  diffViewMode?: DiffViewMode;
  messageViewMode?: MessageViewMode;
  showMessageMap?: boolean;
  aider: {
    options: string;
    environmentVariables: string;
    addRuleFiles: boolean;
    autoCommits: boolean;
    cachingEnabled: boolean;
    watchFiles: boolean;
    confirmBeforeEdit: boolean;
  };
  preferredModels: string[];

  llmProviders: {
    openai?: OpenAiProvider;
    anthropic?: AnthropicProvider;
    gemini?: GeminiProvider;
    groq?: GroqProvider;
    bedrock?: BedrockProvider;
    deepseek?: DeepseekProvider;
    ollama?: OllamaProvider;
    lmstudio?: LmStudioProvider;
    minimax?: MinimaxProvider;
    'openai-compatible'?: OpenAiCompatibleProvider;
    opencode?: OpenCodeProvider;
    'opencode-go'?: OpenCodeGoProvider;
    openrouter?: OpenRouterProvider;
    requesty?: RequestyProvider;
    synthetic?: SyntheticProvider;
    'vertex-ai'?: VertexAiProvider;
  };
  telemetryEnabled: boolean;
  telemetryInformed?: boolean;
  windowTitleTemplate?: string;
  promptBehavior: PromptBehavior;
  server: {
    enabled: boolean;
    readonly: boolean;
    readonlyExtensionUi?: boolean;
    basicAuth: {
      enabled: boolean;
      username: string;
      password: string;
    };
    cors: {
      enabled: boolean;
      origins: string[];
    };
  };
  memory: MemoryConfig;
  taskSettings: TaskSettings;
  hotkeyConfig?: HotkeyConfig;
  extensions?: ExtensionsConfig;
  proxy: {
    enabled: boolean;
    url: string;
    noProxy: string;
  };
  fileWatchMode?: FileWatchMode;
  workflowConfigs?: Record<string, WorkflowConfig>;
}

export interface ProviderProfile {
  id: string;
  name?: string;
  provider: LlmProvider;
  headers?: Record<string, string>;
  disabled?: boolean;
  extensionId?: string;
}

export interface ProvidersUpdatedData {
  providers: ProviderProfile[];
}

export interface AgentProfilesUpdatedData {
  profiles: AgentProfile[];
}

export interface McpServersData {
  global: Record<string, McpServerConfig>;
  projectServers: Record<string, Record<string, McpServerConfig>>;
}

export interface VoiceSession {
  ephemeralToken: string;
  model: string;
  idleTimeoutMs: number;
}

export interface ProjectStartedData {
  baseDir: string;
}

export interface ClearTaskData {
  baseDir: string;
  taskId: string;
  clearMessages: boolean;
  clearSession: boolean;
}

export interface ContextInfoData {
  baseDir: string;
  taskId: string;
  canUndoContextChange: boolean;
}

export interface TokensCost {
  tokens: number;
  tokensEstimated?: boolean;
  cost: number;
}

export interface TokensInfoData {
  baseDir: string;
  taskId: string;
  chatHistory: TokensCost;
  files: Record<string, TokensCost>;
  repoMap: TokensCost;
  systemMessages: TokensCost;
  agent?: TokensCost;
}

export interface InputHistoryData {
  baseDir: string;
  taskId: string;
  inputHistory: string[];
}

export interface UserMessageData {
  type: 'user';
  id: string;
  baseDir: string;
  taskId: string;
  content: string;
  images?: string[];
  promptContext?: PromptContext;
  timestamp?: number;
}

export interface MessageRemovedData {
  baseDir: string;
  taskId: string;
  messageIds: string[];
}

export interface FileEdit {
  path: string;
  original: string;
  updated: string;
}

export interface GenericTool {
  groupName: string;
  name: string;
  description: string;
}

export interface McpToolInputSchema extends Record<string, unknown> {
  type: 'object';
  properties?: Record<string, unknown>;
}

export interface McpTool {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: McpToolInputSchema;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
  headers?: Readonly<Record<string, string>>;
}

export enum McpOAuthStatus {
  NotRequired = 'not-required',
  AuthenticationRequired = 'authentication-required',
  Authorizing = 'authorizing',
  Authenticated = 'authenticated',
}

export interface McpOAuthStatusData {
  status: McpOAuthStatus;
}

export interface VersionsInfo {
  aiderDeskCurrentVersion?: string | null;
  aiderCurrentVersion?: string | null;
  aiderDeskAvailableVersion?: string | null;
  aiderAvailableVersion?: string | null;
  aiderDeskDownloadProgress?: number;
  aiderDeskNewVersionReady?: boolean;
  releaseNotes?: string | null;
}

export enum FileWriteMode {
  Overwrite = 'overwrite',
  Append = 'append',
  CreateOnly = 'create_only',
}

export interface ModelInfo {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheWriteInputTokenCost?: number;
  cacheReadInputTokenCost?: number;
  useTemperature?: boolean;
  temperature?: number;
}

export interface TaskContext {
  version?: number;
  contextMessages: ContextMessage[];
  contextFiles: ContextFile[];
}

export interface TaskStateData {
  messages: (ResponseCompletedData | UserMessageData | ToolData)[];
  files: ContextFile[];
  todoItems: TodoItem[];
  question: QuestionData | null;
  queuedPrompts: QueuedPromptData[];
  workingMode: WorkingMode;
}

export const WorkingModeSchema = z.enum(['local', 'worktree']);

export type WorkingMode = z.infer<typeof WorkingModeSchema>;

export interface SwitchToLocalOptions {
  mergeBeforeSwitch?: boolean;
  targetBranch?: string;
  switchAllInWorktree?: boolean;
  discardWorktreeChanges?: boolean;
}

export interface SwitchToWorktreeOptions {
  carryOverUncommittedChanges?: boolean;
  dropSourceChanges?: boolean;
}

export const TaskDataSchema = z.object({
  id: z.string(),
  baseDir: z.string(),
  parentId: z.string().nullable().optional(),
  name: z.string(),
  state: z.string().optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  startedAt: z.string().optional(),
  interruptedAt: z.string().optional(),
  completedAt: z.string().optional(),
  worktree: WorktreeSchema.optional(),
  workingMode: WorkingModeSchema.optional(),
  lastMergeState: MergeStateSchema.optional(),
  aiderTotalCost: z.number(),
  agentTotalCost: z.number(),
  autonomyMode: z.enum(AutonomyMode).optional(),
  agentProfileId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  mainModel: z.string(),
  weakModel: z.string().nullable().optional(),
  architectModel: z.string().nullable().optional(),
  reasoningEffort: z.string().optional(),
  thinkingTokens: z.string().optional(),
  currentMode: z.string().optional(),
  contextCompactingThresholdTokens: z.number().optional(),
  weakModelLocked: z.boolean().optional(),
  handoff: z.boolean().optional(),
  hasWorkflowHistory: z.boolean().optional(),
  lastAgentProviderMetadata: z.unknown().optional(),
  lastAgentProviderMetadataModel: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type TaskData = z.infer<typeof TaskDataSchema>;

export interface CreateTaskParams {
  parentId?: string | null;
  name?: string;
  autonomyMode?: AutonomyMode;
  activate?: boolean;
  handoff?: boolean;
  sendEvent?: boolean;
  provider?: string;
  model?: string;
  agentProfileId?: string;
  mode?: Mode;
  workingMode?: WorkingMode;
  addInitialContextFiles?: boolean;
}

export interface TaskCreatedData {
  baseDir: string;
  task: TaskData;
  activate?: boolean;
  editLast?: boolean;
}

export enum DefaultTaskState {
  Todo = 'TODO',
  InProgress = 'IN_PROGRESS',
  Interrupted = 'INTERRUPTED',
  Delegated = 'DELEGATED',
  MoreInfoNeeded = 'MORE_INFO_NEEDED',
  ReadyForReview = 'READY_FOR_REVIEW',
  ReadyForImplementation = 'READY_FOR_IMPLEMENTATION',
  Done = 'DONE',
}

export const DEFAULT_TASK_STATES = new Set<string>(Object.values(DefaultTaskState));

export const TaskStateEmoji: Record<DefaultTaskState, string> = {
  [DefaultTaskState.Todo]: '📋',
  [DefaultTaskState.ReadyForImplementation]: '🚀',
  [DefaultTaskState.InProgress]: '⚙️',
  [DefaultTaskState.Interrupted]: '⏸️',
  [DefaultTaskState.Delegated]: '🔄',
  [DefaultTaskState.MoreInfoNeeded]: '💬',
  [DefaultTaskState.ReadyForReview]: '👀',
  [DefaultTaskState.Done]: '✅',
};

export interface TodoItem {
  name: string;
  completed: boolean;
}

export interface UsageDataRow {
  timestamp: string;
  project: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
}

export interface Model {
  id: string;
  providerId: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxOutputTokensLimit?: number;
  temperature?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheWriteInputTokenCost?: number;
  cacheReadInputTokenCost?: number;
  supportsTools?: boolean;
  isCustom?: boolean;
  isHidden?: boolean;
  hasModelOverrides?: boolean;
  providerOverrides?: Record<string, unknown>;
}

export interface ProviderModelsData {
  models?: Model[];
  loading?: boolean;
  errors?: Record<string, string>;
}

export interface ModelOverrides {
  version: number;
  models: Model[];
}

export interface Command {
  name: string;
  description: string;
  arguments: CommandArgument[];
}

export interface CommandArgument {
  description: string;
  required?: boolean;
  options?: string[];
}

export interface CustomCommand extends Command {
  template: string;
  includeContext?: boolean;
  autonomyMode?: AutonomyMode;
  skills?: string[];
}

export interface TerminalData {
  terminalId: string;
  baseDir: string;
  taskId: string;
  data: string;
}

export interface TerminalExitData {
  terminalId: string;
  baseDir: string;
  taskId: string;
  exitCode: number;
  signal?: number;
}

export enum MemoryEntryType {
  Task = 'task',
  UserPreference = 'user-preference',
  CodePattern = 'code-pattern',
}

export interface MemoryEntry {
  id: string;
  content: string;
  type: MemoryEntryType;
  taskId?: string;
  projectId?: string;
  timestamp: number;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  hasWorktree: boolean;
  isRemote?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}
export interface NotificationData {
  baseDir: string;
  title: string;
  body: string;
}

export interface InstalledExtension {
  id: string;
  metadata: {
    name: string;
    version: string;
    description?: string;
    author?: string;
    capabilities?: string[];
    iconUrl?: string;
    hasConfig?: boolean;
    supportedOS?: OS[];
  };
  filePath: string;
  initialized: boolean;
  projectDir?: string;
  readmeContent?: string;
}

export interface ExtensionToolInfo {
  extensionId: string;
  extensionName: string;
  tools: { name: string; description: string }[];
}

export interface AvailableExtension {
  id: string;
  name: string;
  description?: string;
  version: string;
  author?: string;
  capabilities?: string[];
  iconUrl?: string;
  supportedOS?: OS[];
  type: 'single' | 'folder';
  file?: string;
  folder?: string;
  repositoryUrl: string;
  hasDependencies?: boolean;
  readmeContent?: string;
  installCount?: number;
}

export interface ExtensionOperationResult {
  success: boolean;
  error?: string;
}

export interface ExtensionUIComponent {
  extensionId: string;
  componentId: string;
  name?: string;
  placement: string;
  jsx: string;
  loadData?: boolean;
  noDataCache?: boolean;
  libraries?: Record<string, string>;
  messageFilter?: {
    types?: string[];
    serverName?: string;
    toolName?: string;
  };
}

/**
 * A single extension's configuration UI component.
 * Returned by getConfigComponent() for a specific extension.
 */
export interface ExtensionConfigComponent {
  /** JSX/TSX component as string to be parsed to component */
  jsx: string;
}

export interface ExtensionUIRefreshData {
  projectDir?: string;
  extensionId?: string;
  componentId?: string;
  taskId?: string;
  reloadComponents?: boolean;
}

export interface ExtensionsUpdatedData {
  projectDir?: string;
}

export type OpenDialogProperty = 'openFile' | 'openDirectory' | 'multiSelections';

export interface OpenDialogOptions {
  properties: OpenDialogProperty[];
  defaultPath?: string;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface ContextMenuParams {
  x: number;
  y: number;
  selectionText?: string;
  isEditable: boolean;
  linkURL?: string;
}

export interface ModalOverlayUrlData {
  url: string;
}

export type InputPromptType = 'password' | 'text' | 'confirmation';

export interface InputPromptData {
  id: string;
  title?: string;
  titleParams?: Record<string, string | number>;
  message: string;
  messageParams?: Record<string, string | number>;
  type?: InputPromptType;
  placeholder?: string;
  defaultValue?: string;
  allowRememberSession?: boolean;
  rememberSessionLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export type AiderConnectorStatus =
  | { state: 'idle' }
  | { state: 'checking-uv' }
  | { state: 'downloading-uv' }
  | { state: 'creating-venv' }
  | { state: 'installing-packages'; package: string; current: number; total: number }
  | { state: 'setting-up-connector' }
  | { state: 'setting-up-mcp' }
  | { state: 'starting-connector' }
  | { state: 'ready' }
  | { state: 'failed'; error: string };

export interface ChangeRequestItem {
  filename: string;
  lineNumber: number;
  userComment: string;
}

export type SkillLocation = 'global' | 'project' | 'builtin' | 'extension';

export interface SkillDefinition {
  name: string;
  description: string;
  location: SkillLocation;
  dirPath?: string;
  content?: string;
  activated?: boolean;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
}

export interface SkillsUpdatedData {
  baseDir: string;
  taskId: string;
  skills: SkillDefinition[];
}
