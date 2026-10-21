import { lstat, mkdir, mkdtemp, readlink, rm, stat, symlink } from 'fs/promises';
import { tmpdir } from 'os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureProjectConfigLinks } from '../project-config-links';

vi.mock('@/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

describe('ensureProjectConfigLinks', () => {
  let root: string;
  let repoDir: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(`${tmpdir()}/project-config-links-`);
    repoDir = `${root}/aider-desk-dev`;
    projectDir = `${root}/my-project`;
    await mkdir(repoDir, { recursive: true });
    await mkdir(`${projectDir}/.aider-desk`, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does nothing when no config repo is set', async () => {
    await ensureProjectConfigLinks(projectDir, '');

    await expect(lstat(`${projectDir}/.aider-desk/agents`)).rejects.toThrow();
    await expect(lstat(`${projectDir}/.aider-desk/skills`)).rejects.toThrow();
  });

  it('links missing agents and skills directories into the config repo', async () => {
    await ensureProjectConfigLinks(projectDir, repoDir);

    for (const [name, centralDir] of [
      ['agents', 'project-agents'],
      ['skills', 'project-skills'],
    ]) {
      const linkPath = `${projectDir}/.aider-desk/${name}`;
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe(`${repoDir}/${centralDir}/my-project`);
      expect((await stat(`${repoDir}/${centralDir}/my-project`)).isDirectory()).toBe(true);
    }
  });

  it('ignores a trailing slash on the config repo path', async () => {
    await ensureProjectConfigLinks(projectDir, `${repoDir}/`);

    expect(await readlink(`${projectDir}/.aider-desk/agents`)).toBe(`${repoDir}/project-agents/my-project`);
  });

  it('creates the .aider-desk directory when it is missing', async () => {
    await rm(`${projectDir}/.aider-desk`, { recursive: true, force: true });

    await ensureProjectConfigLinks(projectDir, repoDir);

    expect((await lstat(`${projectDir}/.aider-desk/agents`)).isSymbolicLink()).toBe(true);
  });

  it('leaves an existing real agents directory untouched', async () => {
    await mkdir(`${projectDir}/.aider-desk/agents`);

    await ensureProjectConfigLinks(projectDir, repoDir);

    const agents = await lstat(`${projectDir}/.aider-desk/agents`);
    expect(agents.isSymbolicLink()).toBe(false);
    expect(agents.isDirectory()).toBe(true);
    expect((await lstat(`${projectDir}/.aider-desk/skills`)).isSymbolicLink()).toBe(true);
  });

  it('leaves an existing dangling symlink untouched', async () => {
    await symlink('/nonexistent/target', `${projectDir}/.aider-desk/agents`);

    await ensureProjectConfigLinks(projectDir, repoDir);

    expect(await readlink(`${projectDir}/.aider-desk/agents`)).toBe('/nonexistent/target');
  });

  it('does nothing for a project that is not next to the config repo', async () => {
    const otherProject = `${root}/elsewhere/my-project`;
    await mkdir(`${otherProject}/.aider-desk`, { recursive: true });

    await ensureProjectConfigLinks(otherProject, repoDir);

    await expect(lstat(`${otherProject}/.aider-desk/agents`)).rejects.toThrow();
    await expect(lstat(`${repoDir}/project-agents`)).rejects.toThrow();
  });
});
