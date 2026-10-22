import type { TaskNavigationManager } from './task-navigation-manager';

let manager: TaskNavigationManager | null = null;

export const setTaskNavigationManager = (instance: TaskNavigationManager | null): void => {
  manager = instance;
};

export const getTaskNavigationManager = (): TaskNavigationManager | null => manager;

export const requireTaskNavigationManager = (): TaskNavigationManager => {
  if (!manager) {
    throw new Error('Task navigation is not initialised');
  }
  return manager;
};
