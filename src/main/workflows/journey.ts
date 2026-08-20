import type { WorkflowAgentModels, WorkflowConfig } from '@common/types';

export type EditorOutcomeStatus = 'DONE' | 'FAILED' | 'UNKNOWN' | 'BLOCKED';
export type FileAlignment = 'ok' | 'missing' | 'unsolicited';

export interface EditorOutcome {
  editId: number;
  path: string;
  outcome: EditorOutcomeStatus;
  detail?: string;
  editorRole?: 'light' | 'heavy';
}

export interface FileChangeRow {
  path: string;
  insertions: number;
  deletions: number;
  editorOutcome: EditorOutcomeStatus | 'NOT INSTRUCTED';
  alignment: FileAlignment;
  detail?: string;
  editorRole?: 'light' | 'heavy';
}

export interface ContextChangeRecord {
  label: string;
  added: string[];
  removed: string[];
  skipped: string[];
}

export interface EvidenceRow {
  iteration: number;
  verdict: string;
  added: string[];
  removed: string[];
  research: boolean;
}

export interface EditBatchRecord {
  batch: number;
  stage: string;
  editCount: number;
  done: number;
  failed: string[]; // "EDIT <id>: <path>" labels
  blocked: string[];
  unknown: string[];
  verdict: string; // 'ALIGNED' | 'DEFICIENT: <reason>'
  commit: string;
  rows: FileChangeRow[];
}

export interface ReviewRoundRow {
  round: number;
  outcome: 'clean' | 'rectified' | 'failed';
  rectificationEdits: number;
}

export interface Journey {
  evidenceIterations: number;
  evidenceRows: EvidenceRow[];
  filesAdded: string[];
  filesRemoved: string[];
  filesSkipped: string[];
  contextChanges: ContextChangeRecord[];
  researchDocs: number;
  planTitle: string;
  batches: EditBatchRecord[];
  fileStats: Record<string, { insertions: number; deletions: number; passes: number }>;
  formatRetries: number;
  cancelled: boolean;
  modelOverrides: Record<string, WorkflowAgentModels>;
  conversationChars: number;
  editorTimeouts: number;
  reviewRounds: number;
  reviewTable: ReviewRoundRow[];
  arbiterSummaries: Array<{ round: number; summary: string }>;
  arbiterFailures: string[];
  gitRetries: number;
  gitWarnings: string[];
  error?: string;
}

export interface ReportState {
  status: 'aligned' | 'deficient' | 'aborted' | 'cancelled';
  abortStage?: string;
  reportEmitted?: boolean;
}

export function createJourney(modelConfig: WorkflowConfig | undefined, conversationText: string): Journey {
  return {
    evidenceIterations: 0,
    evidenceRows: [],
    filesAdded: [],
    filesRemoved: [],
    filesSkipped: [],
    contextChanges: [],
    researchDocs: 0,
    planTitle: '',
    batches: [],
    fileStats: {},
    formatRetries: 0,
    cancelled: false,
    modelOverrides: modelConfig?.agentModels ?? {},
    conversationChars: conversationText.length,
    editorTimeouts: 0,
    reviewRounds: 0,
    reviewTable: [],
    arbiterSummaries: [],
    arbiterFailures: [],
    gitRetries: 0,
    gitWarnings: [],
  };
}
