---
verified: 2026-10-22
verified_by: workhorse
---

# Task navigation

Task keys, rolling topic maps, global search and a quick task switcher for AiderDesk. The main-process code is in this directory; the renderer code is in `src/renderer/src/components/task-navigation/`. Upstream files change only at the hooks listed under *Hooks in upstream files*, so an upstream merge can conflict only at those lines.

## Features

| Feature | What the code does |
|---|---|
| Task keys | Numbers every saved task of an open project, oldest first, and gives a new number to a task that shares one, such as a duplicated or forked task. A key is `PREFIX-NNN`, for example `ADD-048`. The prefix is the initials of the project folder name (`aider-desk-dev` gives `ADD`) unless it is overridden in Settings → Tasks → Task Navigation. |
| Topic maps | When a prompt finishes, sends the task's topic map and the user and assistant messages it does not yet cover to the summary model, and merges the model's JSON reply into the map. Renames the task to the map's title unless the user renamed it by hand. |
| Global search | Keeps an SQLite FTS5 index of the user and assistant text of every task in every project, including tool names and arguments but not tool output, and local sentence vectors (`Xenova/all-MiniLM-L6-v2`) of task titles, topics and prompts for concept matches. |
| Quick switcher | Lists the most recently updated tasks of the open projects from renderer memory, with their topics, their last message and, for a running task, its current activity. |

The summary model is chosen in Settings → Tasks → Task Navigation. When none is chosen, the task name model is used, then the task's agent model.

Selecting a task in the quick switcher or the search overlay calls `requestTaskActivation` in `src/renderer/src/stores/taskNavigationStore.ts`. `Home` brings the task's project to the front, opening it through the `project` and `task` URL parameters when it is not open; `ProjectView` activates the task; `TaskView` scrolls to the selected message.

## Storage

| Data | Where |
|---|---|
| Task number, topic map, title lock, last-message preview | `TaskData.metadata`, under the keys in `TASK_NAVIGATION_METADATA_KEYS`. The task schema is unchanged. |
| Search index | `task-navigation.db` in the AiderDesk data directory, with the tables `nav_tasks`, `nav_messages`, `nav_messages_fts` and `nav_vectors`. It holds only data derived from the task folders; *Rebuild index* in the search overlay re-reads the task folders of every indexed project. |
| Settings | `SettingsData.taskNavigation`, with defaults in `DEFAULT_TASK_NAVIGATION_SETTINGS`. |

## Files

| File | Role |
|---|---|
| `task-navigation-manager.ts` | Observes task events and runs numbering, topic maps, indexing and embedding in background queues |
| `summary-model.ts` | Topic map prompt, response parsing and merging |
| `search-index.ts` | SQLite store: the FTS5 keyword index and the vector table |
| `message-text.ts` | Reduces context messages to the text that is summarised and indexed |
| `embeddings.ts` | Local sentence embeddings |
| `task-update.ts` | Locks the title on a manual rename; keeps a stale metadata update from overwriting task numbers, topic maps and previews |
| `task-navigation-api.ts`, `ipc.ts` | REST routes under `/api/task-navigation/`, and the Electron IPC handlers |
| `hooks.ts`, `instance.ts` | The event bridge from `EventManager`, and the manager instance |

Shared types and helpers are in `packages/common/src/types/task-navigation.ts`. Strings are in the `taskNavigation` block of `packages/common/src/locales/en.json`.

## Hooks in upstream files

After an upstream merge, check that each of these is still present.

| File | Hook |
|---|---|
| `packages/common/src/types/index.ts` | `export * from './task-navigation'` |
| `packages/common/src/types/common.ts` | `HotkeyConfig.dialogHotkeys.quickSwitcher` and `globalSearch`; `SettingsData.taskNavigation` |
| `packages/common/src/api.ts` | `searchTasks`, `getSearchIndexStatus`, `rebuildSearchIndex`, `regenerateTaskSummary` |
| `packages/common/src/locales/en.json` | the `taskNavigation` block; `settings.hotkeys.quickSwitcher` and `globalSearch` |
| `src/preload/index.ts` | the four API methods over the `task-navigation-*` IPC channels |
| `src/renderer/src/api/browser-api.ts` | the four API methods over `/api/task-navigation/*` |
| `src/renderer/src/__tests__/mocks/api.ts` | mocks of the four API methods |
| `src/main/events/event-manager.ts` | `notifyTaskNavigationEvent(eventType, data)` as the first line of `broadcastToEventConnectors` |
| `src/main/managers.ts` | `initTaskNavigation(...)` after the project manager; `taskNavigationManager.dispose()` in `cleanup` |
| `src/main/server/server-controller.ts` | `new TaskNavigationApi().registerRoutes(apiRouter)` |
| `src/main/index.ts` | `setupTaskNavigationIpcHandlers()` after `setupIpcHandlers(...)` |
| `src/main/events-handler.ts` | `prepareTaskNavigationUpdate(task.task, updates)` in `updateTask` |
| `src/renderer/src/utils/hotkeys.ts` | defaults `mod+j` and `mod+shift+f`; `QUICK_SWITCHER` and `GLOBAL_SEARCH` |
| `src/renderer/src/App.tsx` | `useTaskNavigationHotkeys()`; `<QuickSwitcher />` and `<GlobalSearch />` after `<CommandPalette />` |
| `src/renderer/src/pages/Home.tsx` | `usePendingProjectActivation(...)` |
| `src/renderer/src/components/project/ProjectView.tsx` | `usePendingTaskActivation(...)` |
| `src/renderer/src/components/project/TaskView.tsx` | `usePendingMessageScroll(...)`; `<TaskTopicPanel />` in the message area |
| `src/renderer/src/components/project/TaskBar.tsx` | `<TopicMapToggleButton />` before the `task-top-bar-right` extension slot |
| `src/renderer/src/components/project/TaskSidebar/TaskItem.tsx` | `<TaskNamePreview />` in place of the task name and its tooltip |
| `src/renderer/src/components/settings/TaskSettings.tsx` | `<TaskNavigationSettings />` after the Tasks section |
| `src/renderer/src/components/settings/HotkeysSettings.tsx` | rows for the two dialog hotkeys |

## Verify

Read-only; run on the Z-Book.

```bash
# 1. The module files, the shared types file, the store and the nine renderer files exist
cd ~/code/iwd/aider-desk-dev/aider-desk && ls src/main/task-navigation/{task-navigation-manager,summary-model,search-index,message-text,embeddings,task-update,task-navigation-api,ipc,hooks,instance}.ts packages/common/src/types/task-navigation.ts src/renderer/src/stores/taskNavigationStore.ts | wc -l; ls src/renderer/src/components/task-navigation | wc -l
# 2. Main-process hooks: event bridge, start, dispose, REST routes, IPC handlers, update adjustment
cd ~/code/iwd/aider-desk-dev/aider-desk && for p in "src/main/events/event-manager.ts|notifyTaskNavigationEvent(eventType, data)" "src/main/managers.ts|initTaskNavigation(" "src/main/managers.ts|taskNavigationManager.dispose()" "src/main/server/server-controller.ts|new TaskNavigationApi().registerRoutes(apiRouter)" "src/main/index.ts|setupTaskNavigationIpcHandlers()" "src/main/events-handler.ts|prepareTaskNavigationUpdate(task.task, updates)"; do grep -cF "${p#*|}" "${p%%|*}"; done | paste -sd' '
# 3. Shared contract hooks: type export, hotkey and settings fields, the four API methods in the contract, the preload, the browser API and the test mock
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cF "export * from './task-navigation'" packages/common/src/types/index.ts; grep -cE "quickSwitcher: string|globalSearch: string|taskNavigation\?: Partial<TaskNavigationSettings>" packages/common/src/types/common.ts; grep -cE "^  (searchTasks|getSearchIndexStatus|rebuildSearchIndex|regenerateTaskSummary):" packages/common/src/api.ts; grep -c "ipcRenderer.invoke('task-navigation-" src/preload/index.ts; grep -c "'/task-navigation/" src/renderer/src/api/browser-api.ts; grep -cE "^    (searchTasks|getSearchIndexStatus|rebuildSearchIndex|regenerateTaskSummary): vi.fn" src/renderer/src/__tests__/mocks/api.ts; } | paste -sd' '
# 4. Hotkey defaults mod+j and mod+shift+f, and their accessors
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -cE "quickSwitcher: 'mod\+j'|globalSearch: 'mod\+shift\+f'|QUICK_SWITCHER: dk.quickSwitcher|GLOBAL_SEARCH: dk.globalSearch" src/renderer/src/utils/hotkeys.ts
# 5. Renderer hooks in upstream components
cd ~/code/iwd/aider-desk-dev/aider-desk && for p in "src/renderer/src/App.tsx|useTaskNavigationHotkeys();" "src/renderer/src/App.tsx|<QuickSwitcher />" "src/renderer/src/App.tsx|<GlobalSearch />" "src/renderer/src/pages/Home.tsx|usePendingProjectActivation({" "src/renderer/src/components/project/ProjectView.tsx|usePendingTaskActivation(projectDir" "src/renderer/src/components/project/TaskView.tsx|usePendingMessageScroll(task.id" "src/renderer/src/components/project/TaskView.tsx|<TaskTopicPanel task=" "src/renderer/src/components/project/TaskBar.tsx|<TopicMapToggleButton />" "src/renderer/src/components/project/TaskSidebar/TaskItem.tsx|<TaskNamePreview " "src/renderer/src/components/settings/TaskSettings.tsx|<TaskNavigationSettings " "src/renderer/src/components/settings/HotkeysSettings.tsx|'dialogHotkeys', 'quickSwitcher'" "src/renderer/src/components/settings/HotkeysSettings.tsx|'dialogHotkeys', 'globalSearch'"; do grep -cF "${p#*|}" "${p%%|*}"; done | paste -sd' '
# 6. Storage and strings: metadata keys, index file name, index tables, the locale block, the hotkey labels
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cE "^  (taskNumber|taskSummary|nameLocked|lastMessagePreview): '" packages/common/src/types/task-navigation.ts; grep -cF "'task-navigation.db'" src/main/task-navigation/task-navigation-manager.ts; grep -cE "CREATE (VIRTUAL )?TABLE IF NOT EXISTS nav_(tasks|messages|messages_fts|vectors) " src/main/task-navigation/search-index.ts; grep -c '^  "taskNavigation": {' packages/common/src/locales/en.json; grep -cE '"(quickSwitcher|globalSearch)": "(Quick Task Switcher|Search All Tasks)"' packages/common/src/locales/en.json; } | paste -sd' '
# 7. Default settings
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -A8 "DEFAULT_TASK_NAVIGATION_SETTINGS: TaskNavigationSettings = {" packages/common/src/types/task-navigation.ts | grep -oE "(autoSummarize|summaryModel|autoRegenerateTitle|searchIndexEnabled|conceptSearchEnabled|quickSwitcherCount|projectPrefixes): [^,]+" | paste -sd';'
# 8. Behaviour: numbering, topic maps, scanning and embedding in the manager; no tool output indexed; the quick switcher reads renderer memory; the summary model falls back to the task name model; the embedding model
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cE "private async (assignTaskNumbers|summarize|scan|embedTask)\(" src/main/task-navigation/task-navigation-manager.ts; grep -cF "message.role === 'tool'" src/main/task-navigation/message-text.ts; grep -cF "useProjectStore((state) => state.projectTasksMap)" src/renderer/src/components/task-navigation/QuickSwitcher.tsx; grep -cF "taskSettings?.taskNameModel" src/main/task-navigation/task-navigation-manager.ts; grep -cF "Xenova/all-MiniLM-L6-v2" src/main/task-navigation/embeddings.ts; } | paste -sd' '
# 9. REST routes
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -oE "'/task-navigation/[a-z-]+'" src/main/task-navigation/task-navigation-api.ts | sort | paste -sd' '
# 10. A manual rename locks the title, and a test asserts the prefix derivation
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -cF -e "metadata[lockKey] = true" -e "deriveProjectPrefix('/home/user/code/aider-desk-dev')).toBe('ADD')" src/main/task-navigation/task-update.ts src/main/task-navigation/__tests__/task-update.test.ts
```

**Expected**

1. `12`, then `9`.
2. `1 1 1 1 1 1`
3. `1 3 4 4 4 4`
4. `4`
5. `1 1 1 1 1 1 1 1 1 1 1 1`
6. `4 1 4 1 2`
7. `autoSummarize: true;summaryModel: null;autoRegenerateTitle: true;searchIndexEnabled: true;conceptSearchEnabled: true;quickSwitcherCount: 6;projectPrefixes: {}`
8. `4 1 1 1 1`
9. `'/task-navigation/index-status' '/task-navigation/rebuild-index' '/task-navigation/regenerate-summary' '/task-navigation/search'`
10. `src/main/task-navigation/task-update.ts:1` and `src/main/task-navigation/__tests__/task-update.test.ts:1`

**Manual checks:** none.
