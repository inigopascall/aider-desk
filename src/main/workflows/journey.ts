import type { WorkflowModelSet } from '@common/types';

export type EditorOutcomeStatus = 'DONE' | 'FAILED' | 'UNKNOWN';
export type FileAlignment = 'ok' | 'missing' | 'unsolicited';

export interface EditorOutcome {
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

export interface EditPassRecord {
  pass: number;
  stage: string;
  editCount: number;
  done: number;
  failed: string[];
  unknown: string[];
  verdict: string;
  commit: string;
  rows: FileChangeRow[];
}

export interface ReviewRoundRow {
  round: number;
  correctness: string;
  quality: string;
  outcome: 'clean' | 'rectified' | 'exhausted';
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
  digesterVerdicts: string[];
  planTitle: string;
  unknownsResearchResolved: boolean;
  unknownsCodebaseResolved: boolean;
  ambiguities: string | null;
  passes: EditPassRecord[];
  fileStats: Record<string, { insertions: number; deletions: number; passes: number }>;
  formatRetries: number;
  confirmerSkips: number;
  cancelled: boolean;
  modelSetName: string;
  modelOverrides: Record<string, string>;
  conversationChars: number;
  reviewRounds: number;
  reviewTable: ReviewRoundRow[];
  reviewFindings: { round: number; findings: string }[];
  reviewerConsiderations: string | null;
  verifierFailures: string[];
  gitRetries: number;
  gitWarnings: string[];
  error?: string;
}

export interface ReportState {
  status: 'aligned' | 'deficient' | 'aborted' | 'cancelled';
  abortStage?: string;
  reportEmitted?: boolean;
}

export function createJourney(modelSet: WorkflowModelSet | undefined, conversationText: string): Journey {
  return {
    evidenceIterations: 0,
    evidenceRows: [],
    filesAdded: [],
    filesRemoved: [],
    filesSkipped: [],
    contextChanges: [],
    researchDocs: 0,
    digesterVerdicts: [],
    planTitle: '',
    unknownsResearchResolved: false,
    unknownsCodebaseResolved: false,
    ambiguities: null,
    passes: [],
    fileStats: {},
    formatRetries: 0,
    confirmerSkips: 0,
    cancelled: false,
    modelSetName: modelSet?.name ?? '',
    modelOverrides: modelSet?.models ?? {},
    conversationChars: conversationText.length,
    reviewRounds: 0,
    reviewTable: [],
    reviewFindings: [],
    reviewerConsiderations: null,
    verifierFailures: [],
    gitRetries: 0,
    gitWarnings: [],
  };
}
