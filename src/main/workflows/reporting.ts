import type {
  ContextChangeRecord,
  EvidenceRow,
  FileChangeRow,
  Journey,
  ReportState,
} from './journey';

const ALIGNMENT_GLYPH: Record<FileChangeRow['alignment'], string> = {
  ok: '✅',
  missing: '❌',
  unsolicited: '⚠️',
};

const OUTCOME_GLYPH: Record<string, string> = {
  DONE: '✅',
  FAILED: '❌',
  UNKNOWN: '❔',
  BLOCKED: '⛔',
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

export function formatWorkflowStart(workflowName: string, modelsSummary: string, conversationChars: number): string {
  return section(
    `### 🚀 ${workflowName} starting`,
    markdownTable(
      ['Field', 'Value'],
      ['left', 'left'],
      [
        ['Models', modelsSummary],
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
    ['Edit batches', String(journey.batches.length)],
    ['Files touched', String(Object.keys(journey.fileStats).length)],
  ];

  return [
    `## ${workflowName} — ${label} Checkpoint`,
    markdownTable(['Field', 'Value'], ['left', 'left'], rows),
    journey.evidenceRows.length
      ? section('### 🧾 Evidence', markdownTable(['Round', 'Verdict', 'Added', 'Removed', 'Research'], ['right', 'left', 'left', 'left', 'center'], evidenceRows(journey.evidenceRows)))
      : null,
    journey.batches.length
      ? section('### ✍️ Edit batches', markdownTable(['Batch', 'Stage', 'Edits', 'Verdict'], ['right', 'left', 'right', 'left'], journey.batches.map((b) => [String(b.batch), b.stage, String(b.editCount), b.verdict])))
      : null,
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
  edits: Array<{ id: number; path: string; type: 'NEW' | 'EDIT' | 'DELETE' }>,
): string {
  const plural = edits.length === 1 ? '' : 's';
  const opLabel = (type: 'NEW' | 'EDIT' | 'DELETE') =>
    type === 'NEW' ? '🆕 CREATE' : type === 'DELETE' ? '🗑️ DELETE' : '✏️ EDIT';
  return section(
    `### 🧩 ${label}`,
    `Decomposed into **${edits.length}** file edit${plural}.`,
    markdownTable(
      ['#', 'File', 'Op'],
      ['right', 'left', 'left'],
      edits.map((edit) => [String(edit.id), edit.path, opLabel(edit.type)]),
    ),
  );
}

export function formatEditBatchSummary(
  stage: string,
  batch: number,
  rows: FileChangeRow[],
  passed: boolean,
  reason: string,
): string {
  return section(
    '### ✍️ Edits applied',
    `_${stage} — batch ${batch}_`,
    markdownTable(
      ['File', '+', '−', 'Editor', 'Aligned'],
      ['left', 'right', 'right', 'left', 'center'],
      rows.map((row) => [
        row.path,
        String(row.insertions),
        String(row.deletions),
        `${OUTCOME_GLYPH[row.editorOutcome]} ${row.editorOutcome}`,
        ALIGNMENT_GLYPH[row.alignment],
      ]),
    ),
    passed
      ? '_All edits applied and structurally validated._'
      : `_Structural validation failed: ${reason}_`,
  );
}

export function formatArbiterRound(round: number, summary: string, rectificationEdits: number): string {
  return section(
    `### ⚖️ Arbiter review — round ${round}`,
    truncate(summary, 4000),
    rectificationEdits === 0
      ? '_✅ No rectification required._'
      : `_🛠️ ${rectificationEdits} rectification edit(s) queued._`,
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

  const overrideEntries = Object.entries(journey.modelOverrides).filter(
    ([, m]) => (m.primary && m.primary.trim().length > 0) || (m.fallback && m.fallback.trim().length > 0),
  );
  const modelOverridesSummary =
    overrideEntries.length === 0
      ? 'Agent profile defaults'
      : overrideEntries
          .map(([role, m]) => `${role}: ${m.primary ?? 'default'}${m.fallback ? ` (fallback: ${m.fallback})` : ''}`)
          .join('; ');

  const summaryRows = [
    ['Status', status],
    ['Plan', journey.planTitle || '—'],
    ['Model overrides', modelOverridesSummary],
    ['Evidence rounds', String(journey.evidenceIterations)],
    ['Research documents', String(journey.researchDocs)],
    ['Context files', `+${journey.filesAdded.length} / −${journey.filesRemoved.length}${journey.filesSkipped.length ? ` / ${journey.filesSkipped.length} skipped` : ''}`],
    ['Edit batches', String(journey.batches.length)],
    ['Files touched', String(Object.keys(journey.fileStats).length)],
    ['Format retries', String(journey.formatRetries)],
  ];

  if (journey.gitRetries > 0) summaryRows.push(['Git retries', String(journey.gitRetries)]);

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
    journey.batches.length > 0
      ? section(
          '### ✍️ Edit batches',
          markdownTable(
            ['Batch', 'Stage', 'Edits', 'DONE', 'FAILED', 'BLOCKED', 'UNKNOWN', 'Verdict', 'Commit'],
            ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'left', 'left'],
            journey.batches.map((batch) => [
              String(batch.batch),
              batch.stage,
              String(batch.editCount),
              String(batch.done),
              batch.failed.length ? batch.failed.join(', ') : '—',
              batch.blocked.length ? batch.blocked.join(', ') : '—',
              batch.unknown.length ? batch.unknown.join(', ') : '—',
              batch.verdict,
              code(batch.commit),
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
            ['Round', 'Outcome', 'Rectification edits'],
            ['right', 'left', 'right'],
            journey.reviewTable.map((row) => [
              String(row.round),
              row.outcome,
              String(row.rectificationEdits),
            ]),
          ),
          ...journey.arbiterSummaries.map((arbiter) =>
            section(`#### Arbiter review — round ${arbiter.round}`, truncate(arbiter.summary, 4000)),
          ),
          journey.arbiterFailures.length > 0
            ? section('#### ⚠️ Arbiter failures', journey.arbiterFailures.map((failure) => `- ${failure}`).join('\n'))
            : null,
        )
      : null,
    journey.gitWarnings.length > 0 ? section('### ⚠️ Git warnings', journey.gitWarnings.map((w) => `- ${w}`).join('\n')) : null,
    journey.error ? section('### ❌ Error', journey.error) : null,
  ];

  return blocks.filter((block): block is string => !!block && block.trim().length > 0).join('\n\n');
}
