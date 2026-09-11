import { ContextFile } from '@common/types';

export interface TreeItem {
  index: string | number;
  isFolder?: boolean;
  children?: (string | number)[];
  data: string;
  file?: ContextFile;
}

export type SectionType = 'updated' | 'project' | 'context' | 'mappings' | 'rules' | 'skills' | 'outline';

export const normalizePath = (path: string): string => {
  return path.replace(/\\/g, '/');
};

export const createFileTree = (files: ContextFile[], rootId = 'root') => {
  const tree: Record<string, TreeItem> = {
    [rootId]: { index: rootId, children: [], isFolder: true, data: rootId },
  };

  files.forEach((file) => {
    const pathParts = file.path.split(/[\\/]/);

    let currentNode = tree[rootId];
    pathParts.forEach((part, partIndex) => {
      const isLastPart = partIndex === pathParts.length - 1;
      const nodeId = pathParts.slice(0, partIndex + 1).join('/');

      if (!tree[nodeId]) {
        tree[nodeId] = {
          index: nodeId,
          children: [],
          data: part,
          isFolder: !isLastPart,
          file: isLastPart ? file : undefined,
        };
        if (!currentNode.children) {
          currentNode.children = [];
        }
        currentNode.children.push(nodeId);
      }

      if (isLastPart) {
        tree[nodeId].data = part;
        tree[nodeId].isFolder = false;
        tree[nodeId].file = file;
      }

      currentNode = tree[nodeId];
    });
  });

  Object.values(tree).forEach((node) => {
    if (node.children && node.children.length > 0) {
      node.children.sort((aId, bId) => {
        const a = tree[aId];
        const b = tree[bId];
        if (a.isFolder && !b.isFolder) {
          return -1;
        }
        if (!a.isFolder && b.isFolder) {
          return 1;
        }
        return a.data.localeCompare(b.data);
      });
    }
  });

  return tree;
};

export const collectVisibleFilePaths = (
  tree: Record<string, TreeItem>,
  expandedItems: string[],
  rootId = 'root',
): string[] => {
  const visiblePaths: string[] = [];

  const visit = (nodeId: string, isRoot = false) => {
    const node = tree[nodeId];
    if (!node) {
      return;
    }

    if (!node.isFolder) {
      if (node.file?.path) {
        visiblePaths.push(node.file.path);
      }
      return;
    }

    if (!isRoot && !expandedItems.includes(nodeId)) {
      return;
    }

    node.children?.forEach((childId) => visit(String(childId)));
  };

  visit(rootId, true);
  return visiblePaths;
};

export const applyContextFilesDisabled = (
  files: ContextFile[],
  paths: string[],
  disabled: boolean,
): ContextFile[] => {
  const normalizedPaths = new Set(paths.map(normalizePath));

  return files.map((file) =>
    normalizedPaths.has(normalizePath(file.path)) ? { ...file, disabled } : file,
  );
};
