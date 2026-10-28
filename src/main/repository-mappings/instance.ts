import type { RepositoryMappingsManager } from './mappings-manager';

let manager: RepositoryMappingsManager | null = null;

export const setRepositoryMappingsManager = (instance: RepositoryMappingsManager | null): void => {
  manager = instance;
};

export const getRepositoryMappingsManager = (): RepositoryMappingsManager | null => manager;

export const requireRepositoryMappingsManager = (): RepositoryMappingsManager => {
  if (!manager) {
    throw new Error('Repository mappings are not initialised');
  }
  return manager;
};
