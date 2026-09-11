import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TreeItemRenderer } from '../TreeItemRenderer';

import type { UpdatedFile } from '@common/types';
import type { TreeItem } from '../types';

import { render } from '@/__tests__/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const item: TreeItem = {
  index: 'src/file.ts',
  data: 'file.ts',
  file: { path: 'src/file.ts' },
};

const createProps = () => ({
  item,
  title: 'file.ts',
  children: null,
  type: 'updated' as const,
  treeData: { 'src/file.ts': item },
  expandedItems: [],
  setExpandedItems: vi.fn(),
  contextFilesMap: new Map(),
  updatedFiles: [{ path: 'src/file.ts', additions: 1, deletions: 0 } as UpdatedFile],
  os: null,
  onFileDiffClick: vi.fn(),
  onRevertFile: vi.fn(),
  onDropFile: vi.fn(() => vi.fn()),
  onAddFile: vi.fn(() => vi.fn()),
});

describe('TreeItemRenderer updated files', () => {
  it('shows a muted add-to-Git action for untracked files', () => {
    const props = createProps();
    const onAddFileToGit = vi.fn();
    props.updatedFiles[0].isUntracked = true;

    render(<TreeItemRenderer {...props} onAddFileToGit={onAddFileToGit} />);

    expect(screen.getByText('file.ts')).toHaveClass('text-text-muted-light');
    fireEvent.click(screen.getByRole('button'));
    expect(onAddFileToGit).toHaveBeenCalledWith('src/file.ts');
    expect(props.onRevertFile).not.toHaveBeenCalled();
  });

  it('keeps the original revert action for tracked unstaged files', () => {
    const props = createProps();
    const onAddFileToGit = vi.fn();

    render(<TreeItemRenderer {...props} onAddFileToGit={onAddFileToGit} />);

    expect(screen.getByText('file.ts')).toHaveClass('text-text-primary');
    fireEvent.click(screen.getByRole('button'));
    expect(props.onRevertFile).toHaveBeenCalledWith('src/file.ts');
    expect(onAddFileToGit).not.toHaveBeenCalled();
  });
});

describe('TreeItemRenderer context files', () => {
  const createContextProps = (disabled = false) => {
    const contextItem: TreeItem = { ...item, file: { path: 'src/file.ts', disabled } };
    return {
      ...createProps(),
      item: contextItem,
      title: 'file.ts',
      type: 'context' as const,
      treeData: { 'src/file.ts': contextItem },
      contextFilesMap: new Map([['src/file.ts', contextItem.file]]),
    };
  };

  it('renders enabled and disabled context checkboxes and dims disabled files', () => {
    const enabledProps = createContextProps();
    const onToggleContextFiles = vi.fn();
    const { unmount } = render(<TreeItemRenderer {...enabledProps} onToggleContextFiles={onToggleContextFiles} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    unmount();

    const disabledProps = createContextProps(true);
    render(<TreeItemRenderer {...disabledProps} onToggleContextFiles={onToggleContextFiles} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('file.ts')).toHaveClass('context-dimmed');
  });

  it('passes the context path and ordinary-click shift flag when toggled', () => {
    const props = createContextProps(true);
    const onToggleContextFiles = vi.fn();
    render(<TreeItemRenderer {...props} onToggleContextFiles={onToggleContextFiles} />);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleContextFiles).toHaveBeenCalledWith(['src/file.ts'], false, false);
  });

  it('passes true for shift-click context toggles', () => {
    const props = createContextProps(true);
    const onToggleContextFiles = vi.fn();
    render(<TreeItemRenderer {...props} onToggleContextFiles={onToggleContextFiles} />);

    fireEvent.click(screen.getByRole('checkbox'), { shiftKey: true });
    expect(onToggleContextFiles).toHaveBeenCalledWith(['src/file.ts'], false, true);
  });

  it('requests disabling when an enabled file checkbox is clicked', () => {
    const props = createContextProps();
    const onToggleContextFiles = vi.fn();
    render(<TreeItemRenderer {...props} onToggleContextFiles={onToggleContextFiles} />);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleContextFiles).toHaveBeenCalledWith(['src/file.ts'], true, false);
  });

  it('renders an indeterminate context folder and toggles all descendant paths', () => {
    const folder: TreeItem = { index: 'src', data: 'src', isFolder: true, children: ['src/a.ts', 'src/b.ts'] };
    const first: TreeItem = { index: 'src/a.ts', data: 'a.ts', file: { path: 'src/a.ts' } };
    const second: TreeItem = { index: 'src/b.ts', data: 'b.ts', file: { path: 'src/b.ts', disabled: true } };
    const onToggleContextFiles = vi.fn();
    render(
      <TreeItemRenderer
        {...createProps()}
        item={folder}
        title="src"
        type="context"
        treeData={{ src: folder, 'src/a.ts': first, 'src/b.ts': second }}
        contextFilesMap={new Map([
          ['src/a.ts', first.file!],
          ['src/b.ts', second.file!],
        ])}
        onToggleContextFiles={onToggleContextFiles}
      >
        <TreeItemRenderer {...createProps()} item={first} title="a.ts" type="context" treeData={{}} contextFilesMap={new Map()} />
      </TreeItemRenderer>,
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveProperty('indeterminate', true);
    fireEvent.click(checkbox);
    expect(onToggleContextFiles).toHaveBeenCalledWith(['src/a.ts', 'src/b.ts'], false, false);
  });
});
