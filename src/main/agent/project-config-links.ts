import * as fs from 'fs/promises';
import * as path from 'path';

import { AIDER_DESK_DIR } from '@/constants';
import logger from '@/logger';

/**
 * Root of the repository that holds per-project agents and skills, e.g. /home/inigo/code/iwd/aider-desk-dev.
 * When unset, no links are created.
 */
export const getConfigRepoDir = (): string => process.env.AIDER_DESK_CONFIG_REPO_DIR?.trim() ?? '';

const LINKED_DIRS = [
  { name: 'agents', centralDir: 'project-agents' },
  { name: 'skills', centralDir: 'project-skills' },
];

const pathExists = async (filePath: string): Promise<boolean> =>
  fs
    .lstat(filePath)
    .then(() => true)
    .catch(() => false);

/**
 * For a project that sits next to the config repo, links `<project>/.aider-desk/agents` and `.../skills`
 * to `<repo>/project-agents/<project>` and `<repo>/project-skills/<project>`, creating the targets.
 * Anything already at a link path (directory, file or symlink, even a dangling one) is left untouched.
 */
export const ensureProjectConfigLinks = async (projectDir: string, configRepoDir: string = getConfigRepoDir()): Promise<void> => {
  if (!configRepoDir) {
    return;
  }

  const repoDir = configRepoDir.replace(/\/+$/, '');
  const project = projectDir.replace(/\/+$/, '');
  if (path.dirname(project) !== path.dirname(repoDir)) {
    logger.debug(`Project ${project} is not next to ${repoDir}; not linking its agents or skills`);
    return;
  }

  const projectName = path.basename(project);
  for (const { name, centralDir } of LINKED_DIRS) {
    const linkPath = path.join(project, AIDER_DESK_DIR, name);
    if (await pathExists(linkPath)) {
      continue;
    }

    const target = path.join(repoDir, centralDir, projectName);
    try {
      await fs.mkdir(target, { recursive: true });
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.symlink(target, linkPath, 'dir');
      logger.info(`Linked ${linkPath} -> ${target}`);
    } catch (err) {
      logger.error(`Failed to link ${linkPath} -> ${target}: ${err}`);
    }
  }
};
