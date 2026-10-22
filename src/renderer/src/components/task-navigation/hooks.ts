import { useEffect, useMemo, useRef } from 'react';
import { ProjectData, TaskData, TaskNavigationSettings, getTaskNavigationSettings } from '@common/types';
import { compareBaseDirs } from '@common/utils';
import { useHotkeys } from 'react-hotkeys-hook';
import { useSearchParams } from 'react-router-dom';

import { useConfiguredHotkeys } from '@/hooks/useConfiguredHotkeys';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';
import { URL_PARAMS, encodeBaseDir } from '@/utils/routes';

const HOTKEY_OPTIONS = { scopes: 'home', enableOnFormTags: true, enableOnContentEditable: true };
const FIRST_SCROLL_DELAY_MS = 350;
const SECOND_SCROLL_DELAY_MS = 1200;

export const useTaskNavigationSettings = (): TaskNavigationSettings => {
  const taskNavigation = useSettingsStore((state) => state.settings?.taskNavigation);
  return useMemo(() => getTaskNavigationSettings({ taskNavigation }), [taskNavigation]);
};

/** App: opens the quick task switcher and the global search. */
export const useTaskNavigationHotkeys = () => {
  const { DIALOG_HOTKEYS } = useConfiguredHotkeys();
  const toggleQuickSwitcher = useTaskNavigationStore((state) => state.toggleQuickSwitcher);
  const toggleGlobalSearch = useTaskNavigationStore((state) => state.toggleGlobalSearch);

  useHotkeys(
    DIALOG_HOTKEYS.QUICK_SWITCHER,
    (event) => {
      event.preventDefault();
      toggleQuickSwitcher();
    },
    HOTKEY_OPTIONS,
    [DIALOG_HOTKEYS.QUICK_SWITCHER, toggleQuickSwitcher],
  );

  useHotkeys(
    DIALOG_HOTKEYS.GLOBAL_SEARCH,
    (event) => {
      event.preventDefault();
      toggleGlobalSearch();
    },
    HOTKEY_OPTIONS,
    [DIALOG_HOTKEYS.GLOBAL_SEARCH, toggleGlobalSearch],
  );
};

type PendingProjectActivationOptions = {
  projectsLoaded: boolean;
  openProjects: ProjectData[];
  activeProject: string | undefined;
  setActiveProject: (baseDir: string) => void;
};

/**
 * Home: brings the project of a requested task to the front. A project that is not open is opened through the
 * project and task URL parameters, which also activate the task once the project has loaded.
 */
export const usePendingProjectActivation = ({ projectsLoaded, openProjects, activeProject, setActiveProject }: PendingProjectActivationOptions) => {
  const pendingActivation = useTaskNavigationStore((state) => state.pendingActivation);
  const [, setSearchParams] = useSearchParams();
  const handledNonceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!pendingActivation || !projectsLoaded || handledNonceRef.current === pendingActivation.nonce) {
      return;
    }
    handledNonceRef.current = pendingActivation.nonce;

    const openProject = openProjects.find((project) => compareBaseDirs(project.baseDir, pendingActivation.baseDir));
    if (openProject) {
      if (!activeProject || !compareBaseDirs(activeProject, openProject.baseDir)) {
        setActiveProject(openProject.baseDir);
      }
      return;
    }

    setSearchParams({ [URL_PARAMS.PROJECT]: encodeBaseDir(pendingActivation.baseDir), [URL_PARAMS.TASK]: pendingActivation.taskId });
  }, [pendingActivation, projectsLoaded, openProjects, activeProject, setActiveProject, setSearchParams]);
};

/** ProjectView: activates a requested task of this project once the project's tasks are loaded. */
export const usePendingTaskActivation = (
  projectDir: string,
  tasks: TaskData[],
  ready: boolean,
  activateTask: (taskId: string, shouldFocusActiveTaskPrompt?: boolean) => void,
) => {
  const pendingActivation = useTaskNavigationStore((state) => state.pendingActivation);
  const completeTaskActivation = useTaskNavigationStore((state) => state.completeTaskActivation);

  useEffect(() => {
    if (!pendingActivation || !ready || !compareBaseDirs(pendingActivation.baseDir, projectDir)) {
      return;
    }
    if (tasks.some((task) => task.id === pendingActivation.taskId)) {
      activateTask(pendingActivation.taskId, !pendingActivation.messageId);
    }
    completeTaskActivation(pendingActivation.nonce);
  }, [pendingActivation, ready, projectDir, tasks, activateTask, completeTaskActivation]);
};

/** TaskView: scrolls to a requested message once the task is shown and its messages are loaded. */
export const usePendingMessageScroll = (taskId: string, isActive: boolean, ready: boolean, scrollToMessage: (messageId: string) => void) => {
  const pendingScroll = useTaskNavigationStore((state) => state.pendingScroll);
  const completeMessageScroll = useTaskNavigationStore((state) => state.completeMessageScroll);

  useEffect(() => {
    if (!pendingScroll || pendingScroll.taskId !== taskId || !isActive || !ready) {
      return;
    }
    const { messageId, nonce } = pendingScroll;
    const firstAttempt = window.setTimeout(() => scrollToMessage(messageId), FIRST_SCROLL_DELAY_MS);
    const secondAttempt = window.setTimeout(() => {
      if (!document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)) {
        scrollToMessage(messageId);
      }
      completeMessageScroll(nonce);
    }, SECOND_SCROLL_DELAY_MS);

    return () => {
      window.clearTimeout(firstAttempt);
      window.clearTimeout(secondAttempt);
    };
  }, [pendingScroll, taskId, isActive, ready, scrollToMessage, completeMessageScroll]);
};
