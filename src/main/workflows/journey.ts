import type { WorkflowAgentModels, WorkflowConfig } from '@common/types';

export type AssignmentOutcomeStatus = 'DONE' | 'FAILED' | 'BLOCKED';
export type FileAlignment = 'ok' | 'missing' | 'unsolicited';

export interface AssignmentOutcome {
  id: number;
  path: string;
  operation: 'CREATE' | 'MODIFY' | 'DELETE';
  outcome: AssignmentOutcomeStatus;
  detail?: string;
  usedFallback?: boolean;
  contextComplaint?: string;
}

export interface FileChangeRow {
  path: string;
  insertions: number;
  deletions: number;
  outcome: AssignmentOutcomeStatus | 'NOT INSTRUCTED';
  alignment: FileAlignment;
  detail?: string;
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

export interface AssignmentBatchRecord {
  batch: number;
  stage: string;
  assignmentCount: number;
  waves: number;
  done: number;
  failed: string[]; // "ASSIGNMENT <id>: <path>" labels
  blocked: string[];
  verdict: string; // 'ALIGNED' | 'DEFICIENT: <reason>'
  commit: string;
  rows: FileChangeRow[];
}

export interface ReviewRoundRow {
  round: number;
  outcome: 'clean' | 'rectified' | 'failed';
  rectificationEdits: number;
  arbitrateAgain: boolean;
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
  batches: AssignmentBatchRecord[];
  fileStats: Record<string, { insertions: number; deletions: number; passes: number }>;
  formatRetries: number;
  cancelled: boolean;
  modelOverrides: Record<string, WorkflowAgentModels>;
  conversationChars: number;
  editorTimeouts: number;
  fallbackRetries: number;
  claudeBackoffRetries: number;
  reviewRounds: number;
  reviewTable: ReviewRoundRow[];
  arbiterSummaries: Array<{ round: number; summary: string }>;
  arbiterFailures: string[];
  arbiterEnabled: boolean;
  reviewerRoles: string[];
  reviewerReports: Array<{ role: string; report: string }>;
  reviewerFailures: string[];
  confirmerReport: string | null;
  confirmerFailure: string | null;
  lastValidationOutput: string | null;
  gitRetries: number;
  gitWarnings: string[];
  contextComplaints: Array<{
    assignmentId: number;
    path: string;
    complaint: string;
  }>;
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
    fallbackRetries: 0,
    claudeBackoffRetries: 0,
    reviewRounds: 0,
    reviewTable: [],
    arbiterSummaries: [],
    arbiterFailures: [],
    arbiterEnabled: false,
    reviewerRoles: [],
    reviewerReports: [],
    reviewerFailures: [],
    confirmerReport: null,
    confirmerFailure: null,
    lastValidationOutput: null,
    gitRetries: 0,
    gitWarnings: [],
    contextComplaints: [],
  };
}
