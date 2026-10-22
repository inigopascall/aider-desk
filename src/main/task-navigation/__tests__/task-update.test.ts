import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_NAVIGATION_SETTINGS,
  TaskData,
  deriveProjectPrefix,
  formatTaskKey,
  getProjectPrefix,
  getTaskKey,
  getTaskNavigationSettings,
} from '@common/types';

import { prepareTaskNavigationUpdate } from '../task-update';

const makeTask = (overrides: Partial<TaskData> = {}): TaskData => ({
  id: 't1',
  baseDir: '/home/user/code/aider-desk-dev',
  name: 'Old name',
  aiderTotalCost: 0,
  agentTotalCost: 0,
  mainModel: 'provider/model',
  ...overrides,
});

describe('prepareTaskNavigationUpdate', () => {
  it('locks the title when the task is renamed by hand', () => {
    const current = makeTask({ metadata: { taskNumber: 3 } });
    expect(prepareTaskNavigationUpdate(current, { name: 'New name' })).toEqual({ name: 'New name', metadata: { taskNumber: 3, nameLocked: true } });
  });

  it('leaves updates without a rename or metadata untouched', () => {
    const current = makeTask();
    const pin = { pinned: true };
    const generating = { name: '<<generating>>' };
    const sameName = { name: 'Old name' };

    expect(prepareTaskNavigationUpdate(current, pin)).toBe(pin);
    expect(prepareTaskNavigationUpdate(current, generating)).toBe(generating);
    expect(prepareTaskNavigationUpdate(current, sameName)).toBe(sameName);
  });

  it('keeps managed metadata and the title lock when the interface sends a stale copy', () => {
    const current = makeTask({ metadata: { taskNumber: 3, nameLocked: true, highlightColor: 'blue' } });
    const result = prepareTaskNavigationUpdate(current, { metadata: { taskNumber: 99, taskSummary: { title: 'stale' }, highlightColor: 'red' } });

    expect(result.metadata).toEqual({ taskNumber: 3, nameLocked: true, highlightColor: 'red' });
  });

  it('lets the interface unlock the title', () => {
    const current = makeTask({ metadata: { taskNumber: 3, nameLocked: true } });
    const result = prepareTaskNavigationUpdate(current, { metadata: { taskNumber: 3, nameLocked: false } });

    expect(result.metadata).toEqual({ taskNumber: 3, nameLocked: false });
  });
});

describe('task keys', () => {
  it('derives a prefix from the project folder name', () => {
    expect(deriveProjectPrefix('/home/user/code/aider-desk-dev')).toBe('ADD');
    expect(deriveProjectPrefix('/home/user/code/toggle/')).toBe('TOG');
    expect(deriveProjectPrefix('/home/user/code/api.the-hub-v3')).toBe('ATHV');
    expect(deriveProjectPrefix('/')).toBe('TASK');
  });

  it('prefers a configured prefix and formats the key', () => {
    const settings = getTaskNavigationSettings({ taskNavigation: { projectPrefixes: { '/home/user/code/aider-desk-dev/': 'adx' } } });

    expect(getProjectPrefix('/home/user/code/aider-desk-dev', settings)).toBe('ADX');
    expect(formatTaskKey('ADD', 48)).toBe('ADD-048');
    expect(formatTaskKey('ADD', 1234)).toBe('ADD-1234');
    expect(getTaskKey(makeTask({ metadata: { taskNumber: 7 } }), settings)).toBe('ADX-007');
    expect(getTaskKey(makeTask(), DEFAULT_TASK_NAVIGATION_SETTINGS)).toBeUndefined();
  });

  it('fills and clamps the settings', () => {
    expect(getTaskNavigationSettings(undefined)).toEqual(DEFAULT_TASK_NAVIGATION_SETTINGS);
    expect(getTaskNavigationSettings({ taskNavigation: { quickSwitcherCount: 50 } }).quickSwitcherCount).toBe(20);
    expect(getTaskNavigationSettings({ taskNavigation: { quickSwitcherCount: 1 } }).quickSwitcherCount).toBe(3);
  });
});
