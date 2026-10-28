import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextFilesPane } from '../ContextFilesPane';

import type { ContextManifestEntry, ContextManifestSection, ContextNotSentReason, TaskContextManifest, TokensInfoData } from '@common/types';

import { render } from '@/__tests__/render';
import { createMockApi } from '@/__tests__/mocks/api';
import { ApiContext } from '@/contexts/ApiContext';
import { EMPTY_TASK_STATE, updateTaskState, useTaskStore } from '@/stores/taskStore';
import { showErrorNotification } from '@/utils/notifications';
import { CONTEXT_USAGE_COLORS } from '@/components/project/context-usage-layout';

vi.mock('@/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/notifications')>()),
  showErrorNotification: vi.fn(),
}));

vi.mock('@/stores/fileEditorStore', () => ({
  useFileEditorStore: (selector: (state: { openFile: (...args: unknown[]) => void }) => unknown) => selector({ openFile: vi.fn() }),
}));

vi.mock('../EmptyContextInfo', () => ({
  EmptyContextInfo: () => null,
}));

const BASE_DIR = '/project';
const TASK_ID = 'task-1';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const createDeferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const entry = (path: string, overrides: Partial<ContextManifestEntry> = {}): ContextManifestEntry => ({
  path,
  displayPath: path,
  readOnly: false,
  selected: true,
  delivery: 'content',
  ...overrides,
});

const unselected = (path: string, overrides: Partial<ContextManifestEntry> = {}): ContextManifestEntry =>
  entry(path, { selected: false, delivery: 'none', notSentReason: 'unselected', ...overrides });

const rules = (...entries: ContextManifestEntry[]): ContextManifestSection => ({ id: 'rules', placement: 'system-prompt', entries });
const mappings = (...entries: ContextManifestEntry[]): ContextManifestSection => ({ id: 'mappings', placement: 'messages-after-history', entries });
const files = (...entries: ContextManifestEntry[]): ContextManifestSection => ({ id: 'files', placement: 'messages-after-history', entries });
const manifestOf = (...sections: ContextManifestSection[]): TaskContextManifest => ({ baseDir: BASE_DIR, taskId: TASK_ID, mode: 'agent', sections });

const storedManifest = (): TaskContextManifest => useTaskStore.getState().taskStateMap.get(TASK_ID)?.contextManifest ?? manifestOf();

const renderPane = (manifest: TaskContextManifest, { deferred = false }: { deferred?: boolean } = {}) => {
  const requests: Deferred[] = [];
  const api = createMockApi({
    setTaskFileSelection: vi.fn((): Promise<void> => {
      if (!deferred) {
        return Promise.resolve();
      }
      const request = createDeferred();
      requests.push(request);
      return request.promise;
    }),
    // Like the backend, answers with a fresh copy of the current state.
    getTaskContextManifest: vi.fn((): Promise<TaskContextManifest> => Promise.resolve({ ...storedManifest() })),
  });

  updateTaskState(TASK_ID, { ...EMPTY_TASK_STATE, loaded: true, contextManifest: manifest });
  render(
    <ApiContext.Provider value={api}>
      <ContextFilesPane
        mode="agent"
        baseDir={BASE_DIR}
        taskId={TASK_ID}
        isOpen={true}
        totalStats={{ additions: 0, deletions: 0 }}
        showFileDialog={() => undefined}
        onDropAllFiles={() => undefined}
        refreshContextFiles={() => Promise.resolve()}
        onToggle={() => undefined}
      />
    </ApiContext.Provider>,
  );

  return { api, requests };
};

// Simulates a context-manifest-updated event from the backend.
const setManifest = (manifest: TaskContextManifest) => {
  act(() => {
    updateTaskState(TASK_ID, { contextManifest: manifest });
  });
};

const flushRequests = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const getSection = (id: string): HTMLElement => screen.getByTestId(`context-section-${id}`);

const getBox = (name: string, sectionId?: string): HTMLElement => {
  const scope = sectionId ? within(getSection(sectionId)) : within(document.body);
  return scope.getByRole('checkbox', { name });
};

describe('ContextFilesPane', () => {
  beforeEach(() => {
    vi.mocked(showErrorNotification).mockClear();
  });

  afterEach(() => {
    cleanup();
    useTaskStore.setState({ taskStateMap: new Map() });
  });

  describe('layout', () => {
    it('renders the sections in manifest order with their counts, placements and folder groups', () => {
      renderPane(
        manifestOf(
          rules(
            entry('/home/user/.aider-desk/rules/global.md', { displayPath: '~/.aider-desk/rules/global.md', source: 'global-rule' }),
            entry('/project/AGENTS.md', { displayPath: 'AGENTS.md', source: 'project-rule' }),
          ),
          mappings(unselected('/project/.aider-desk/mappings/repo-map.txt', { displayPath: '.aider-desk/mappings/repo-map.txt' })),
          files(entry('src/main/a.ts'), entry('b.ts'), unselected('src/main/c.ts')),
        ),
      );

      const sectionIds = screen.getAllByTestId(/^context-section-(rules|mappings|files)$/).map((element) => element.getAttribute('data-testid'));
      expect(sectionIds).toEqual(['context-section-rules', 'context-section-mappings', 'context-section-files']);

      expect(within(getSection('rules')).getByText('2/2')).toBeInTheDocument();
      expect(within(getSection('mappings')).getByText('0/1')).toBeInTheDocument();
      expect(within(getSection('files')).getByText('2/3')).toBeInTheDocument();
      expect(screen.getByText('(4/6)')).toBeInTheDocument();

      expect(within(getSection('rules')).getByText('contextFiles.placementSystemPrompt')).toBeInTheDocument();
      expect(within(getSection('files')).getByText('contextFiles.placementAfterHistory')).toBeInTheDocument();

      const headings = (id: string) =>
        within(getSection(id))
          .getAllByTestId('context-group-heading')
          .map((heading) => heading.textContent);
      expect(headings('rules')).toEqual(['~/.aider-desk/rules', './']);
      expect(headings('mappings')).toEqual(['.aider-desk/mappings']);
      expect(headings('files')).toEqual(['src/main', './']);

      // Rows show the file name only.
      expect(within(getSection('files')).getByText('a.ts')).toBeInTheDocument();
      expect(within(getSection('rules')).getByText('global.md')).toBeInTheDocument();
    });

    it('collapses a folder group', () => {
      renderPane(manifestOf(files(entry('src/a.ts'), entry('c.ts'))));

      fireEvent.click(within(getSection('files')).getByRole('button', { name: 'src' }));

      expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
      expect(screen.getByText('c.ts')).toBeInTheDocument();
    });
  });

  describe('section and group boxes', () => {
    it('selects a whole section with one call and shows a mixed section as indeterminate', async () => {
      const { api } = renderPane(manifestOf(rules(entry('AGENTS.md')), files(entry('src/a.ts'), unselected('src/b.ts'), entry('c.ts'))));

      const sectionBox = getBox('contextFiles.sectionFiles', 'files');
      expect(sectionBox).toHaveProperty('indeterminate', true);

      fireEvent.click(sectionBox);
      expect(getBox('src/b.ts')).toBeChecked();
      await flushRequests();

      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(1);
      expect(api.setTaskFileSelection).toHaveBeenCalledWith(BASE_DIR, TASK_ID, 'files', ['src/a.ts', 'src/b.ts', 'c.ts'], true);
    });

    it('unticks every entry of a fully ticked section', async () => {
      const { api } = renderPane(manifestOf(rules(entry('AGENTS.md'), entry('CLAUDE.md'))));

      fireEvent.click(getBox('contextFiles.sectionRules', 'rules'));
      await flushRequests();

      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(1);
      expect(api.setTaskFileSelection).toHaveBeenCalledWith(BASE_DIR, TASK_ID, 'rules', ['AGENTS.md', 'CLAUDE.md'], false);
    });

    it('sends one call with only the paths of the clicked group', async () => {
      const { api } = renderPane(manifestOf(files(entry('src/a.ts'), entry('src/b.ts'), entry('c.ts'))));

      fireEvent.click(getBox('src', 'files'));
      await flushRequests();

      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(1);
      expect(api.setTaskFileSelection).toHaveBeenCalledWith(BASE_DIR, TASK_ID, 'files', ['src/a.ts', 'src/b.ts'], false);
      expect(getBox('c.ts')).toBeChecked();
    });
  });

  describe('shift-click', () => {
    it('applies the clicked state to the visible range in one call, across groups', async () => {
      const { api } = renderPane(manifestOf(files(entry('src/a.ts'), entry('src/b.ts'), entry('c.ts'))));

      fireEvent.click(getBox('src/a.ts'));
      await flushRequests();
      fireEvent.click(getBox('c.ts'), { shiftKey: true });
      await flushRequests();

      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(2);
      expect(api.setTaskFileSelection).toHaveBeenNthCalledWith(2, BASE_DIR, TASK_ID, 'files', ['src/a.ts', 'src/b.ts', 'c.ts'], false);
    });

    it('affects only the clicked row when the anchor was set in another section', async () => {
      const { api } = renderPane(manifestOf(rules(entry('AGENTS.md'), entry('CLAUDE.md')), files(entry('a.ts'), entry('b.ts'), entry('c.ts'))));

      fireEvent.click(getBox('AGENTS.md'));
      await flushRequests();
      fireEvent.click(getBox('c.ts'), { shiftKey: true });
      await flushRequests();

      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(2);
      expect(api.setTaskFileSelection).toHaveBeenNthCalledWith(1, BASE_DIR, TASK_ID, 'rules', ['AGENTS.md'], false);
      expect(api.setTaskFileSelection).toHaveBeenNthCalledWith(2, BASE_DIR, TASK_ID, 'files', ['c.ts'], false);
    });
  });

  describe('optimistic selection', () => {
    it('keeps an unticked mapping and an unticked rule unticked through the confirming manifest', async () => {
      const mapPath = '/project/.aider-desk/mappings/repo-map.txt';
      const rulePath = '/project/.aider-desk/rules/style.md';
      const mapDisplay = '.aider-desk/mappings/repo-map.txt';
      const ruleDisplay = '.aider-desk/rules/style.md';
      const { api, requests } = renderPane(
        manifestOf(
          rules(entry(rulePath, { displayPath: ruleDisplay, source: 'project-rule' })),
          mappings(entry(mapPath, { displayPath: mapDisplay })),
          files(),
        ),
        { deferred: true },
      );

      fireEvent.click(getBox(mapDisplay));
      fireEvent.click(getBox(ruleDisplay));
      expect(getBox(mapDisplay)).not.toBeChecked();
      expect(getBox(ruleDisplay)).not.toBeChecked();

      await flushRequests();
      requests[0].resolve();
      await flushRequests();
      expect(getBox(mapDisplay)).not.toBeChecked();
      expect(getBox(ruleDisplay)).not.toBeChecked();

      setManifest(
        manifestOf(
          rules(unselected(rulePath, { displayPath: ruleDisplay, source: 'project-rule' })),
          mappings(unselected(mapPath, { displayPath: mapDisplay })),
          files(),
        ),
      );
      expect(getBox(mapDisplay)).not.toBeChecked();
      expect(getBox(ruleDisplay)).not.toBeChecked();

      requests[1].resolve();
      await flushRequests();
      expect(getBox(mapDisplay)).not.toBeChecked();
      expect(getBox(ruleDisplay)).not.toBeChecked();

      expect(vi.mocked(api.setTaskFileSelection).mock.calls).toEqual([
        [BASE_DIR, TASK_ID, 'mappings', [mapPath], false],
        [BASE_DIR, TASK_ID, 'rules', [rulePath], false],
      ]);
    });

    it('shows the new state immediately while the request is pending', async () => {
      const { api, requests } = renderPane(manifestOf(files(entry('a.ts'), entry('b.ts'), unselected('c.ts'))), { deferred: true });
      expect(getBox('a.ts')).toBeChecked();
      expect(screen.getByText('(2/3)')).toBeInTheDocument();

      fireEvent.click(getBox('a.ts'));
      expect(getBox('a.ts')).not.toBeChecked();
      expect(screen.getByText('(1/3)')).toBeInTheDocument();

      await flushRequests();
      expect(api.setTaskFileSelection).toHaveBeenCalledWith(BASE_DIR, TASK_ID, 'files', ['a.ts'], false);

      setManifest(manifestOf(files(unselected('a.ts'), entry('b.ts'), unselected('c.ts'))));
      requests[0].resolve();
      await flushRequests();
      expect(getBox('a.ts')).not.toBeChecked();
      expect(api.getTaskContextManifest).not.toHaveBeenCalled();

      // A later backend change to the entry is shown, so nothing is left overriding it.
      setManifest(manifestOf(files(entry('a.ts'), entry('b.ts'), unselected('c.ts'))));
      expect(getBox('a.ts')).toBeChecked();
    });

    it('reverts, reports the error and re-fetches the manifest when the request fails', async () => {
      const { api, requests } = renderPane(manifestOf(files(entry('a.ts'), entry('b.ts'), unselected('c.ts'))), { deferred: true });

      fireEvent.click(getBox('a.ts'));
      expect(getBox('a.ts')).not.toBeChecked();

      await flushRequests();
      requests[0].reject(new Error('boom'));
      await flushRequests();

      expect(getBox('a.ts')).toBeChecked();
      expect(screen.getByText('(2/3)')).toBeInTheDocument();
      expect(showErrorNotification).toHaveBeenCalledWith('boom');
      expect(api.getTaskContextManifest).toHaveBeenCalledWith(BASE_DIR, TASK_ID);
    });

    it('sends requests one at a time and a failed toggle does not undo a later toggle of another entry', async () => {
      const { api, requests } = renderPane(manifestOf(files(entry('a.ts'), entry('b.ts'), unselected('c.ts'))), { deferred: true });

      fireEvent.click(getBox('a.ts'));
      fireEvent.click(getBox('b.ts'));
      expect(getBox('a.ts')).not.toBeChecked();
      expect(getBox('b.ts')).not.toBeChecked();
      expect(screen.getByText('(0/3)')).toBeInTheDocument();

      await flushRequests();
      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(1);

      requests[0].reject(new Error('a failed'));
      await flushRequests();

      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(2);
      expect(api.setTaskFileSelection).toHaveBeenNthCalledWith(2, BASE_DIR, TASK_ID, 'files', ['b.ts'], false);
      expect(getBox('a.ts')).toBeChecked();
      expect(getBox('b.ts')).not.toBeChecked();
      expect(showErrorNotification).toHaveBeenCalledWith('a failed');
    });

    it('keeps the last click when the same entry is toggled repeatedly and older updates arrive', async () => {
      const { api, requests } = renderPane(manifestOf(files(entry('a.ts'), entry('b.ts'))), { deferred: true });

      fireEvent.click(getBox('a.ts'));
      fireEvent.click(getBox('a.ts'));
      fireEvent.click(getBox('a.ts'));
      expect(getBox('a.ts')).not.toBeChecked();

      await flushRequests();
      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(1);
      expect(api.setTaskFileSelection).toHaveBeenNthCalledWith(1, BASE_DIR, TASK_ID, 'files', ['a.ts'], false);

      setManifest(manifestOf(files(unselected('a.ts'), entry('b.ts'))));
      requests[0].resolve();
      await flushRequests();
      expect(api.setTaskFileSelection).toHaveBeenNthCalledWith(2, BASE_DIR, TASK_ID, 'files', ['a.ts'], true);
      expect(getBox('a.ts')).not.toBeChecked();

      // The update for the second click shows the entry ticked, but the third click is still pending.
      setManifest(manifestOf(files(entry('a.ts'), entry('b.ts'))));
      expect(getBox('a.ts')).not.toBeChecked();
      requests[1].resolve();
      await flushRequests();
      expect(api.setTaskFileSelection).toHaveBeenNthCalledWith(3, BASE_DIR, TASK_ID, 'files', ['a.ts'], false);
      expect(getBox('a.ts')).not.toBeChecked();

      setManifest(manifestOf(files(unselected('a.ts'), entry('b.ts'))));
      requests[2].resolve();
      await flushRequests();
      expect(getBox('a.ts')).not.toBeChecked();
      expect(api.setTaskFileSelection).toHaveBeenCalledTimes(3);

      setManifest(manifestOf(files(entry('a.ts'), entry('b.ts'))));
      expect(getBox('a.ts')).toBeChecked();
    });
  });

  describe('not-sent notices', () => {
    it.each([
      ['profile-excludes-mappings', 'contextFiles.notSentProfileExcludesMappings'],
      ['aider-mode', 'contextFiles.notSentAiderMode'],
    ])('shows one notice when every selected mapping is held back by %s', (reason, key) => {
      const notSentReason = reason as ContextNotSentReason;
      renderPane(
        manifestOf(mappings(entry('m1.txt', { delivery: 'none', notSentReason }), entry('m2.txt', { delivery: 'none', notSentReason }), unselected('m3.txt'))),
      );

      expect(within(getSection('mappings')).getByTestId('context-section-notice')).toHaveTextContent(key);
      expect(within(getSection('mappings')).queryByTestId('context-entry-not-sent')).not.toBeInTheDocument();
      expect(within(getSection('mappings')).getByText('0/3')).toBeInTheDocument();
    });

    it('shows the rule-files-disabled notice on the rules section', () => {
      renderPane(manifestOf(rules(entry('AGENTS.md', { delivery: 'none', notSentReason: 'aider-rule-files-disabled' }))));

      expect(within(getSection('rules')).getByTestId('context-section-notice')).toHaveTextContent('contextFiles.notSentAiderRuleFilesDisabled');
    });

    it('shows the path-only notice when every selected file is listed by path', () => {
      renderPane(manifestOf(files(entry('a.ts', { delivery: 'path-only' }), entry('b.ts', { delivery: 'path-only' }), unselected('c.ts'))));

      expect(within(getSection('files')).getByTestId('context-section-notice')).toHaveTextContent('contextFiles.listedPathOnly');
      expect(within(getSection('files')).getByText('2/3')).toBeInTheDocument();
    });

    it('marks only the affected row when the reasons are mixed', () => {
      renderPane(manifestOf(mappings(entry('m1.txt', { delivery: 'none', notSentReason: 'profile-excludes-mappings' }), entry('m2.txt'))));

      expect(within(getSection('mappings')).queryByTestId('context-section-notice')).not.toBeInTheDocument();
      expect(within(getSection('mappings')).getAllByTestId('context-entry-not-sent')).toHaveLength(1);
    });

    it('dims unticked rows', () => {
      renderPane(manifestOf(files(entry('a.ts'), unselected('b.ts'))));

      expect(screen.getByText('b.ts')).toHaveClass('context-dimmed');
      expect(screen.getByText('a.ts')).not.toHaveClass('context-dimmed');
    });
  });

  describe('token usage', () => {
    const item = (id: string, tokens: number) => ({ id, label: id, tokens });
    const usageSnapshot = (mappingTokens = 200): TokensInfoData => ({
      baseDir: BASE_DIR,
      taskId: TASK_ID,
      chatHistory: { tokens: 0, cost: 0 },
      files: {},
      repoMap: { tokens: 0, cost: 0 },
      systemMessages: { tokens: 0, cost: 0 },
      agent: { tokens: 1000 + mappingTokens, cost: 0 },
      contextBreakdown: {
        categories: [
          { id: 'rules', items: [item('AGENTS.md', 100)], tokens: 100 },
          { id: 'repoMappings', items: [item('map.md', mappingTokens)], tokens: mappingTokens },
          { id: 'readOnlyFiles', items: [item('ro.ts', 50)], tokens: 50 },
          { id: 'editableFiles', items: [item('edit.ts', 150)], tokens: 150 },
          { id: 'conversation', items: [item('msg', 700)], tokens: 700 },
        ],
        totalTokens: 1000 + mappingTokens,
      },
    });

    const setTokensInfo = (tokensInfo: TokensInfoData) => {
      act(() => updateTaskState(TASK_ID, { tokensInfo }));
    };

    const getBar = (filename: string): HTMLElement => {
      const row = screen.getByText(filename).closest('[data-testid="context-entry-row"]');
      expect(row).not.toBeNull();
      return within(row as HTMLElement).getByTestId('context-file-token-bar');
    };

    it('renders section totals, entry proportions, colours and placement from a real usage snapshot', () => {
      renderPane(
        manifestOf(
          rules(entry('AGENTS.md', { source: 'project-rule' })),
          mappings(entry('map.md')),
          files(entry('ro.ts', { readOnly: true }), entry('edit.ts'), unselected('off.ts'), entry('huge.md', { status: { kind: 'over-budget' } })),
        ),
      );
      expect(screen.getAllByTestId('context-section-tokens').map((header) => header.textContent)).toEqual(['—', '—', '—']);

      setTokensInfo(usageSnapshot());

      expect(screen.getAllByTestId('context-section-tokens').map((header) => header.textContent)).toEqual(['100', '200', '200']);
      expect((getBar('map.md').firstElementChild as HTMLElement).style.width).toBe('100%');
      expect((getBar('AGENTS.md').firstElementChild as HTMLElement).style.width).toBe('50%');
      expect((getBar('ro.ts').firstElementChild as HTMLElement).style.width).toBe('25%');
      expect((getBar('edit.ts').firstElementChild as HTMLElement).style.width).toBe('75%');
      expect((getBar('off.ts').firstElementChild as HTMLElement).style.width).toBe('0%');
      expect((getBar('huge.md').firstElementChild as HTMLElement).style.width).toBe('0%');

      const normalizedColor = (color: string) => {
        const span = document.createElement('span');
        span.style.backgroundColor = color;
        return span.style.backgroundColor;
      };
      expect((getBar('AGENTS.md').firstElementChild as HTMLElement).style.backgroundColor).toBe(normalizedColor(CONTEXT_USAGE_COLORS.rules));
      expect((getBar('map.md').firstElementChild as HTMLElement).style.backgroundColor).toBe(normalizedColor(CONTEXT_USAGE_COLORS.repoMappings));
      expect((getBar('ro.ts').firstElementChild as HTMLElement).style.backgroundColor).toBe(normalizedColor(CONTEXT_USAGE_COLORS.readOnlyFiles));
      expect((getBar('edit.ts').firstElementChild as HTMLElement).style.backgroundColor).toBe(normalizedColor(CONTEXT_USAGE_COLORS.editableFiles));

      const header = within(getSection('rules')).getByTestId('context-section-tokens');
      const placement = within(getSection('rules')).getByText('contextFiles.placementSystemPrompt');
      expect(header.compareDocumentPosition(placement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('rerenders entry proportions, maximum and section totals when usage changes', () => {
      renderPane(manifestOf(rules(entry('AGENTS.md')), mappings(entry('map.md')), files(entry('ro.ts', { readOnly: true }), entry('edit.ts'))));
      setTokensInfo(usageSnapshot(200));
      setTokensInfo(usageSnapshot(100));

      expect(screen.getAllByTestId('context-section-tokens').map((header) => header.textContent)).toEqual(['100', '100', '200']);
      expect(getBar('edit.ts')).toHaveAttribute('data-max-tokens', '150');
      expect(getBar('edit.ts')).toHaveAttribute('data-token-bar-fill', '100');
      expect(Number(getBar('AGENTS.md').getAttribute('data-token-bar-fill'))).toBeCloseTo((100 / 150) * 100);
      expect(Number(getBar('map.md').getAttribute('data-token-bar-fill'))).toBeCloseTo((100 / 150) * 100);
      expect(Number(getBar('ro.ts').getAttribute('data-token-bar-fill'))).toBeCloseTo((50 / 150) * 100);
    });
  });
});
