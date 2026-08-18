import type {
  ContextChangeRecord,
  EvidenceRow,
  FileChangeRow,
  Journey,
  ReportState,
} from './journey';
import type { EditVerificationResult } from './parsers';

const ALIGNMENT_GLYPH: Record<FileChangeRow['alignment'], string> = {
  ok: '✅',
  missing: '❌',
  unsolicited: '⚠️',
};

const OUTCOME_GLYPH: Record<string, string> = {
  DONE: '✅',
  FAILED: '❌',
  UNKNOWN: '❔',
  'NOT INSTRUCTED': '➕',
};

const STATUS_GLYPH: Record<ReportState['status'], string> = {
  aligned: '✅',
  deficient: '⚠️',
  cancelled: '🛑',
  aborted: '❌',
};

export function escapeCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return normalized || '—';
}

export function code(value: string): string {
  return `\`${value.replace(/`/g, '')}\``;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

export function markdownTable(headers: string[], alignments: Array<'left' | 'right' | 'center'>, rows: string[][]): string {
  if (rows.length === 0) {
    return '';
  }

  const delimiter = (alignment: 'left' | 'right' | 'center'): string => {
    if (alignment === 'right') return '----:';
    if (alignment === 'center') return ':----:';
    return '----';
  };

  const renderRow = (values: string[]): string => `| ${values.map(escapeCell).join(' | ')} |`;
  return [
    renderRow(headers),
    renderRow(alignments.map(delimiter)),
    ...rows.map(renderRow),
  ].join('\n');
}

export function section(heading: string, ...blocks: Array<string | null | undefined>): string {
  return [heading, ...blocks.filter((block): block is string => !!block && block.trim().length > 0)].join('\n\n');
}

function quotedBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function listCell(values: string[]): string {
  if (values.length === 0) return '—';
  if (values.length > 3) return String(values.length);
  return values.map(code).join('<br>');
}

function verdictCell(verdict: string | null): string {
  if (!verdict) return '❌ FAILED';
  return verdict === 'ALIGNED' ? '✅ ALIGNED' : '⚠️ MISALIGNED';
}

export function formatContextChange(label: string, added: string[], removed: string[], skipped: string[]): string {
  const rows = [
    ...added.map((path) => [code('+'), path]),
    ...removed.map((path) => [code('-'), path]),
  ];
  const table = markdownTable(['Change', 'Path'], ['center', 'left'], rows);
  return section(
    '### 📂 Reconfigured context files',
    `_Stage: ${label}_`,
    table,
    skipped.length > 0 ? `_Not found, skipped: ${skipped.join(', ')}_` : null,
  );
}

export function formatEvidenceSufficient(): string {
  return section(
    '### ✅ Evidence sufficient',
    'Determined sufficient evidence to reason with. Proceeding to GRAND PLANNER.',
  );
}

export function formatEvidenceInsufficient(round: number, maxRounds: number, hasResearch: boolean): string {
  return section(
    '### 🔁 More evidence required',
    `Round ${round} of ${maxRounds} — dispatching INVESTIGATOR${hasResearch ? ' and RESEARCHER' : ''}.`,
  );
}

export function formatResearchReceived(round: number, chars: number): string {
  return section(
    '### 📚 Research findings received',
    `Round ${round} — ${chars.toLocaleString()} characters of findings folded into the evidence pool.`,
  );
}

export function formatWorkflowStart(workflowName: string, modelSetName: string, conversationChars: number): string {
  return section(
    `### 🚀 ${workflowName} starting`,
    markdownTable(
      ['Field', 'Value'],
      ['left', 'left'],
      [
        ['Model set', modelSetName],
        ['Prior conversation', `${conversationChars.toLocaleString()} characters`],
      ],
    ),
  );
}

export function formatCheckpointReport(journey: Journey, workflowName: string, label: string): string {
  const rows = [
    ['Evidence rounds', String(journey.evidenceIterations)],
    ['Research documents', String(journey.researchDocs)],
    ['Context files', `+${journey.filesAdded.length} / −${journey.filesRemoved.length}`],
    ['Edit passes', String(journey.passes.length)],
    ['Files touched', String(Object.keys(journey.fileStats).length)],
  ];

  return [
    `## ${workflowName} — ${label} Checkpoint`,
    markdownTable(['Field', 'Value'], ['left', 'left'], rows),
    journey.evidenceRows.length
      ? section('### 🧾 Evidence', markdownTable(['Round', 'Verdict', 'Added', 'Removed', 'Research'], ['right', 'left', 'left', 'left', 'center'], evidenceRows(journey.evidenceRows)))
      : null,
    null,
    journey.passes.length
      ? section('### ✍️ Edit passes', markdownTable(['Pass', 'Stage', 'Edits', 'Verdict'], ['right', 'left', 'right', 'left'], journey.passes.map((pass) => [String(pass.pass), pass.stage, String(pass.editCount), pass.verdict])))
      : null,
    journey.ambiguities ? section('### ❓ Ambiguities', journey.ambiguities) : null,
  ]
    .filter((block): block is string => !!block && block.trim().length > 0)
    .join('\n\n');
}

export function formatPlanProduced(title: string): string {
  return section('### 🧭 Implementation Plan produced', `**${title}**`);
}

export function formatPlanUnknowns(
  label: string,
  researchUnknowns: string | null,
  codebaseUnknowns: string | null,
): string {
  const handlers = researchUnknowns && codebaseUnknowns
    ? 'RESEARCHER and INVESTIGATOR'
    : researchUnknowns
      ? 'RESEARCHER'
      : 'INVESTIGATOR';

  return section(
    '### 🔎 Plan unknowns declared',
    `Implementation Plan includes unknowns; handing to ${handlers} for further investigation.`,
    researchUnknowns ? `**Research required**\n${quotedBlock(truncate(researchUnknowns, 1500))}` : null,
    codebaseUnknowns ? `**Codebase evidence required**\n${quotedBlock(truncate(codebaseUnknowns, 1500))}` : null,
    `_Stage: ${label}_`,
  );
}

export function formatEditTargets(
  label: string,
  edits: Array<{ path: string; type: 'NEW' | 'EDIT' | 'DELETE' }>,
  ambiguities: string | null,
): string {
  const plural = edits.length === 1 ? '' : 's';
  return section(
    `### 🧩 ${label}`,
    `Decomposed into **${edits.length}** file edit${plural}.`,
    markdownTable(
      ['File', 'Type'],
      ['left', 'left'],
      edits.map((edit) => [edit.path, edit.type === 'NEW' ? '🆕 NEW' : edit.type === 'DELETE' ? '🗑️ DELETE' : '✏️ EDIT']),
    ),
    ambiguities
      ? `**Ambiguities resolved by the decompositor**\n\n${truncate(ambiguities, 1200)}`
      : null,
  );
}

export function formatEditSummary(
  stage: string,
  pass: number,
  rows: FileChangeRow[],
  gatePassed: boolean,
  gateReason: string,
): string {
  return section(
    '### ✍️ Edits applied',
    `_${stage} — pass ${pass}_`,
    markdownTable(
      ['File', '+', '−', 'Editor', 'Aligned'],
      ['left', 'right', 'right', 'left', 'center'],
      rows.map((row) => [
        row.path,
        String(row.insertions),
        String(row.deletions),
        `${OUTCOME_GLYPH[row.editorOutcome]} ${row.editorOutcome}${row.editorRole === 'heavy' ? ' (heavy)' : ''}`,
        ALIGNMENT_GLYPH[row.alignment],
      ]),
    ),
    gatePassed
      ? '_All applied edits align with the file-edit specifications — CONFIRMER skipped._'
      : `_Gate failed: ${gateReason}_`,
  );
}

export function formatDeficiencyNotice(reason: string): string {
  return section(
    '### ⚠️ Possible deficiencies detected',
    'Possible deficiencies detected in applied edits; handing to CONFIRMER for confirmation.',
    `_${reason}_`,
  );
}

export function formatVerificationFlags(results: EditVerificationResult[]): string {
  const suspicious = results.filter((r) => r.suspicious);
  if (suspicious.length === 0) {
    return '';
  }
  const lines = suspicious.map((r) => `- **${r.path}**: ${r.reasons.join('; ')}`);
  return `### ⚠️ Script verification flags\n\n${lines.join('\n')}`;
}

export function formatConfirmerVerdict(
  pass: number,
  verdict: 'ALIGNED' | 'DEFICIENT',
  correctiveEdits: number,
): string {
  return section(
    '### 🔍 CONFIRMER verdict',
    verdict === 'ALIGNED'
      ? `Pass ${pass}: ✅ **ALIGNED** — applied edits match the specification.`
      : `Pass ${pass}: ⚠️ **DEFICIENT** — ${correctiveEdits} corrective edit(s) queued for the next pass.`,
  );
}

export function formatReviewRound(
  round: number,
  correctness: string | null,
  quality: string | null,
  findings: string,
  rectificationRequired: boolean,
): string {
  return section(
    `### 🔬 Review round ${round}`,
    markdownTable(
      ['Lens', 'Verdict'],
      ['left', 'left'],
      [
        ['Correctness', verdictCell(correctness)],
        ['Quality', verdictCell(quality)],
        ['Arbiter', rectificationRequired ? '🛠️ Rectification required' : '✅ No action required'],
      ],
    ),
    '#### Arbiter findings',
    findings,
  );
}

function contextRows(changes: ContextChangeRecord[]): string[][] {
  return changes.flatMap((change) => [
    ...change.added.map((path) => [change.label, code('+'), path]),
    ...change.removed.map((path) => [change.label, code('-'), path]),
  ]);
}

function evidenceRows(rows: EvidenceRow[]): string[][] {
  return rows.map((row) => [
    String(row.iteration),
    row.verdict,
    listCell(row.added),
    listCell(row.removed),
    row.research ? '✅' : '—',
  ]);
}

export function formatJourneyReport(journey: Journey, report: ReportState, workflowName: string): string {
  const status = `${STATUS_GLYPH[report.status]} ${titleCase(report.status)}${
    report.status === 'aborted' && report.abortStage ? ` — aborted during ${report.abortStage}` : ''
  }`;

  const summaryRows = [
    ['Status', status],
    ['Plan', journey.planTitle || '—'],
    ['Model set', journey.modelSetName || 'Default'],
    ['Evidence rounds', String(journey.evidenceIterations)],
    ['Research documents', String(journey.researchDocs)],
    ['Context files', `+${journey.filesAdded.length} / −${journey.filesRemoved.length}${journey.filesSkipped.length ? ` / ${journey.filesSkipped.length} skipped` : ''}`],
    ['Edit passes', String(journey.passes.length)],
    ['Files touched', String(Object.keys(journey.fileStats).length)],
    ['Format retries', String(journey.formatRetries)],
    ['CONFIRMER fast-path skips', String(journey.confirmerSkips)],
  ];

  if (journey.gitRetries > 0) summaryRows.push(['Git retries', String(journey.gitRetries)]);

  if (journey.conversationSummarized) {
    summaryRows.push([
      'Conversation',
      `${journey.conversationChars.toLocaleString()} chars → summarized (${journey.summaryChars.toLocaleString()} chars)`,
    ]);
  }

  if (journey.editorTimeouts > 0) {
    summaryRows.push(['Editor timeouts', String(journey.editorTimeouts)]);
  }

  if (journey.reviewRounds > 0) {
    summaryRows.push(['Review rounds', String(journey.reviewRounds)]);
  }

  const blocks: Array<string | null> = [
    `## 🏁 ${workflowName} — Journey Report`,
    markdownTable(['Field', 'Value'], ['left', 'left'], summaryRows),
    journey.evidenceRows.length > 0
      ? section(
          '### 🧾 Evidence',
          markdownTable(['Round', 'Verdict', 'Added', 'Removed', 'Research'], ['right', 'left', 'left', 'left', 'center'], evidenceRows(journey.evidenceRows)),
        )
      : null,
    journey.contextChanges.length > 0
      ? section(
          '### 📂 Context reconfiguration',
          markdownTable(['Stage', 'Change', 'Path'], ['left', 'center', 'left'], contextRows(journey.contextChanges)),
        )
      : null,
    journey.passes.length > 0
      ? section(
          '### ✍️ Edit passes',
          markdownTable(
            ['Pass', 'Stage', 'Edits', 'DONE', 'FAILED', 'UNKNOWN', 'Verdict', 'Commit'],
            ['right', 'left', 'right', 'right', 'right', 'right', 'left', 'left'],
            journey.passes.map((pass) => [
              String(pass.pass),
              pass.stage,
              String(pass.editCount),
              String(pass.done),
              pass.failed.length ? pass.failed.join(', ') : '—',
              pass.unknown.length ? pass.unknown.join(', ') : '—',
              pass.verdict,
              code(pass.commit),
            ]),
          ),
        )
      : null,
    Object.keys(journey.fileStats).length > 0
      ? section(
          '### 📄 File changes',
          markdownTable(
            ['File', '+', '−', 'Passes'],
            ['left', 'right', 'right', 'right'],
            Object.entries(journey.fileStats)
              .sort(([, a], [, b]) => b.insertions + b.deletions - (a.insertions + a.deletions))
              .map(([path, stats]) => [path, String(stats.insertions), String(stats.deletions), String(stats.passes)]),
          ),
        )
      : null,
    journey.reviewRounds > 0
      ? section(
          '### 🔬 Review',
          markdownTable(
            ['Round', 'Correctness', 'Quality', 'Outcome', 'Rectification edits'],
            ['right', 'left', 'left', 'left', 'right'],
            journey.reviewTable.map((row) => [
              String(row.round),
              row.correctness,
              row.quality,
              row.outcome,
              String(row.rectificationEdits),
            ]),
          ),
          ...journey.reviewFindings.map((finding) =>
            section(
              `#### Review round ${finding.round} — arbiter findings`,
              finding.findings,
              finding.correctnessAreas || finding.qualityAreas
                ? `_Verifier areas sound — correctness: ${finding.correctnessAreas ?? '—'} · quality: ${finding.qualityAreas ?? '—'}_`
                : null,
            ),
          ),
          journey.reviewerConsiderations ? section('#### Reviewer considerations', journey.reviewerConsiderations) : null,
          journey.reviewerFailure ? section('#### ⚠️ Review incomplete', journey.reviewerFailure) : null,
          journey.outstandingRectification
            ? section('### 🚧 Outstanding rectification (final round — recorded, not executed)', truncate(journey.outstandingRectification, 4000))
            : null,
          journey.verifierFailures.length > 0
            ? section('#### Verifier failures', journey.verifierFailures.map((failure) => `- ${failure}`).join('\n'))
            : null,
        )
      : null,
    journey.ambiguities ? section('### ❓ Ambiguities', journey.ambiguities) : null,
    journey.gitWarnings.length > 0 ? section('### ⚠️ Git warnings', journey.gitWarnings.map((w) => `- ${w}`).join('\n')) : null,
    journey.error ? section('### ❌ Error', journey.error) : null,
  ];

  return blocks.filter((block): block is string => !!block && block.trim().length > 0).join('\n\n');
}
