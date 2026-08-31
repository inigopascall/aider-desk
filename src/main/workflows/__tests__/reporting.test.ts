import { describe, expect, it } from 'vitest';

import { formatCheckpointReport, formatJourneyReport } from '../reporting';
import { createJourney, type AssignmentBatchRecord, type ReportState } from '../journey';

const batchRecord = (batch: number, stage: string, verdict = 'ALIGNED'): AssignmentBatchRecord => ({
  batch,
  stage,
  assignmentCount: 3,
  waves: 1,
  done: 3,
  failed: [],
  blocked: [],
  verdict,
  commit: `[${stage} batch ${batch}] Example`,
  rows: [],
});

describe('formatJourneyReport batch count', () => {
  it('summary count equals the number of batch rows', () => {
    const journey = createJourney(undefined, '');
    journey.batches.push(batchRecord(1, 'dev-pipeline-review'));
    journey.batches.push(batchRecord(2, 'dev-pipeline-review rectification 1'));
    journey.planTitle = 'Example plan';
    const output = formatJourneyReport(journey, { status: 'aligned' } satisfies ReportState, 'Dev Pipeline + Review');
    expect(output).toContain('| Assignment batches | 2 |');
    expect(output).toContain('dev-pipeline-review rectification 1');
    expect(output).not.toContain('| Assignment batches | 1 |');
  });

  it('reports 1 for a single batch', () => {
    const journey = createJourney(undefined, '');
    journey.batches.push(batchRecord(1, 'dev-pipeline-review'));
    const output = formatJourneyReport(journey, { status: 'aligned' } satisfies ReportState, 'Dev Pipeline + Review');
    expect(output).toContain('| Assignment batches | 1 |');
    expect(output).not.toContain('| Assignment batches | 2 |');
  });

  it('reports 0 and omits the table when there are no batches', () => {
    const journey = createJourney(undefined, '');
    const output = formatJourneyReport(journey, { status: 'aligned' } satisfies ReportState, 'Dev Pipeline + Review');
    expect(output).toContain('| Assignment batches | 0 |');
    expect(output).not.toContain('### ✍️ Assignment batches');
  });
});

describe('formatCheckpointReport batch count', () => {
  it('uses the point-in-time label and matches its own table', () => {
    const journey = createJourney(undefined, '');
    journey.batches.push(batchRecord(1, 'dev-pipeline-review'));
    const first = formatCheckpointReport(journey, 'Dev Pipeline + Review', 'Edits applied');
    expect(first).toContain('| Assignment batches so far | 1 |');
    expect(first).toContain('### ✍️ Assignment batches');

    journey.batches.push(batchRecord(2, 'dev-pipeline-review rectification 1'));
    const second = formatCheckpointReport(journey, 'Dev Pipeline + Review', 'Edits applied');
    expect(second).toContain('| Assignment batches so far | 2 |');
    expect(second).toContain('dev-pipeline-review');
    expect(second).toContain('dev-pipeline-review rectification 1');
  });
});