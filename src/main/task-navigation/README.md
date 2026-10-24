---
verified: 2026-10-24
verified_by: workdonkey
---

# Task navigation

Task keys, rolling topic maps, global search and a quick task switcher for AiderDesk. The main-process code is in this directory; the renderer code is in `src/renderer/src/components/task-navigation/`. Upstream files change only at the hooks listed under *Hooks in upstream files*, so an upstream merge can conflict only at those lines.

## Features

| Feature | What the code does |
|---|---|
| Task keys | Numbers every saved task of an open project, oldest first, and gives a new number to a task that shares one, such as a duplicated or forked task. A key is `PREFIX-NNN`, for example `ADD-048`. The prefix is the initials of the project folder name (`aider-desk-dev` gives `ADD`) unless it is overridden in Settings → Tasks → Task Navigation. |
| Topic maps | When a prompt finishes, sends the task's topic map and the user and assistant messages it does not yet cover to the summary model, and merges the model's JSON reply into the map. Only the current topic, the last topic still in the conversation, grows: a new message joins it or starts a new topic, never an earlier one. `applySummaryUpdate` redirects an assignment to an earlier topic and ignores summary changes to earlier topics, so a finished topic is final. Renames the task to the map's title unless the user renamed it by hand. |
| Topic sections | When a topic closes because a newer topic started, `sectionTopics` in `summary-model.ts` asks the summary model, with `SECTION_SYSTEM_PROMPT`, to divide it into sections: one-line titles over runs of its messages, stored in `TaskTopic.sections`. A topic of more than `MAX_SECTION_MESSAGES` messages must be divided so that no section holds more; an answer that breaks the rules is retried once. A topic with fewer than `MIN_SECTIONED_TOPIC_MESSAGES` messages in the conversation is marked done without a model call. `TaskTopic.sectioned` is `true` once sectioning is done or skipped, and `false` while it is pending: when a model call fails, that topic and every candidate not yet tried are set to `false` and retried at the next update. The current topic has no sections. A rebuild sections every finished topic; finished topics of maps made before sections existed are left as they are. |
| Topic compaction | `previewTopicCompaction`, `compactTopic`, `undoTopicCompaction` and `restoreCompactionArchive` in `task-navigation-manager.ts` compact a finished topic, or a section of one, into one recap at a chosen level of detail, and put it back. `topic-compaction.ts` locates the stretch of stored messages the target covers, and refuses a target that is the current topic, detached, not one run of messages, too short, already compacted or inside a compacted topic, or whose stretch would split a tool call from its result; each refusal is a `TopicCompactionBlockReason`. The topic map model writes the recap with `COMPACTION_SYSTEM_PROMPT` in the `summary` queue; the target length per level is `getCompactionTargetCharacters`. The original messages are written to a sidecar file first; then the stretch is replaced by a marker (`topic-compaction-<id>-prompt`) and the recap (`topic-compaction-<id>`) through `Task.replaceContextMessages`, which, like smart compaction, also clears the task's workflow event log. The record goes to `TaskTopic.compaction` or `TaskTopicSection.compaction`; `messageIds` and `startMessageId` keep the original ids. Nothing changes while the task is running, or when the stretch changed while the recap was written. Undo puts the original messages back wherever the pair now sits. Topic maps, sections and previews never see the pair. A rebuild keeps every topic up to the last one that holds a compaction record. |
| Safeguard against built-in compaction | `ContextManager.setContextMessages` reports every replacement of a conversation through `hooks.ts`. When a replacement the manager did not make removes a recap (`findRemovedCompactionSummaries`), the previous conversation is archived in the task folder; after `/compact` has cleared the task metadata, the task navigation keys are put back, the archive is listed under `compactionArchives`, and records whose recap is gone become `lost`. `reconcileCompactions` runs after every topic map update, archive and restore: a record whose original messages are back, for example after the built-in undo, is dropped with its sidecar. Restoring an archive first archives the current conversation. Smart compaction keeps message ids, so it never archives. |
| Topic map modal | Opens from the task bar button or the topic map hotkey, for the active task only. ↑↓ move through the topics and the messages of expanded topics; in an expanded topic, each section title is a header row above the section's first message, which the keys and the mouse skip. Enter expands or collapses a topic, and on a message closes the modal and scrolls to it. The selected row and the expanded topics are remembered per task. |
| Global search | Keeps an SQLite FTS5 index of the user and assistant text of every task in every project, including tool names and arguments but not tool output, and local sentence vectors (`Xenova/all-MiniLM-L6-v2`) of task titles, topics and prompts for concept matches. Results are ordered by best match, or by the task's last update (Tab in the overlay). The original messages of topic compactions in effect are indexed from their sidecars; a hit on one points at the outermost recap in the conversation (`scroll_target`). |
| Quick switcher | Lists the most recently updated tasks of the open projects from renderer memory, with their latest topics, their last message and, for a running task, its current activity. |

The summary model is chosen in Settings → Tasks → Task Navigation. When none is chosen, the task name model is used, then the task's agent model.

Selecting a task in the quick switcher or the search overlay calls `requestTaskActivation` in `src/renderer/src/stores/taskNavigationStore.ts`. `Home` brings the task's project to the front, opening it through the `project` and `task` URL parameters when it is not open; `ProjectView` activates the task; `TaskView` scrolls to the selected message.

## Storage

| Data | Where |
|---|---|
| Task number, topic map, title lock, last-message preview | `TaskData.metadata`, under the keys in `TASK_NAVIGATION_METADATA_KEYS`. The task schema is unchanged. |
| Search index | `task-navigation.db` in the AiderDesk data directory, with the tables `nav_tasks`, `nav_messages`, `nav_messages_fts` and `nav_vectors`. It holds only data derived from the task folders; *Rebuild index* in the search overlay re-reads the task folders of every indexed project. |
| Compaction sidecars | `topic-compactions/<id>.json` in the task folder (`.aider-desk/tasks/<taskId>/`): the original messages of one compaction, unchanged, with its target and level. Deleted on undo. Read and written by `topic-compaction-store.ts`. |
| Compaction archives | `topic-compactions/archive-<time>.json` in the task folder: a conversation saved before a built-in compaction removed a recap, or before an archive was restored. Listed in `TaskData.metadata` under `compactionArchives`. |
| Scroll targets | The `scroll_target` column of `nav_messages`: for an indexed original message of a compaction, the id of the recap to scroll to. A database without the column gains it when the index opens. |
| Topic map modal state and search order | The renderer's `localStorage`, written by `taskNavigationStore.ts`. |
| Settings | `SettingsData.taskNavigation`, with defaults in `DEFAULT_TASK_NAVIGATION_SETTINGS`. |

## Files

| File | Role |
|---|---|
| `task-navigation-manager.ts` | Observes task events and runs numbering, topic maps, indexing and embedding in background queues |
| `summary-model.ts` | Topic map prompt, response parsing and merging; the sectioning prompt, the validation of its answers and the sectioning loop |
| `topic-compaction.ts` | Compaction logic without I/O: target and stretch checks, preview, compact and undo, reconcile, the safeguard check, the index entries of sidecars, the transcript and the prompt |
| `topic-compaction-store.ts` | Sidecar and archive files in the task folder |
| `search-index.ts` | SQLite store: the FTS5 keyword index and the vector table |
| `message-text.ts` | Reduces context messages to the text that is summarised and indexed |
| `embeddings.ts` | Local sentence embeddings |
| `task-update.ts` | Locks the title on a manual rename; keeps a stale metadata update from overwriting task numbers, topic maps and previews |
| `task-navigation-api.ts`, `ipc.ts` | REST routes under `/api/task-navigation/`, and the Electron IPC handlers |
| `hooks.ts`, `instance.ts` | The event bridge from `EventManager`, and the manager instance |

Shared types and helpers are in `packages/common/src/types/task-navigation.ts`. Strings are in the `taskNavigation` block of `packages/common/src/locales/en.json`. The topic map modal's rows, including the display-only section rows, are built by `buildTopicMapRows` in `src/renderer/src/components/task-navigation/topic-map-rows.ts`.

## Hooks in upstream files

After an upstream merge, check that each of these is still present.

| File | Hook |
|---|---|
| `packages/common/src/types/index.ts` | `export * from './task-navigation'` |
| `packages/common/src/types/common.ts` | `HotkeyConfig.dialogHotkeys.quickSwitcher`, `globalSearch` and `topicMap`; `SettingsData.taskNavigation` |
| `packages/common/src/api.ts` | `searchTasks`, `getSearchIndexStatus`, `rebuildSearchIndex`, `regenerateTaskSummary`, `previewTopicCompaction`, `compactTopic`, `undoTopicCompaction`, `restoreCompactionArchive` |
| `packages/common/src/locales/en.json` | the `taskNavigation` block; `settings.hotkeys.quickSwitcher`, `globalSearch` and `topicMap` |
| `src/preload/index.ts` | the task navigation API methods over the `task-navigation-*` IPC channels |
| `src/renderer/src/api/browser-api.ts` | the task navigation API methods over `/api/task-navigation/*` |
| `src/renderer/src/__tests__/mocks/api.ts` | mocks of the task navigation API methods |
| `src/main/events/event-manager.ts` | `notifyTaskNavigationEvent(eventType, data)` as the first line of `broadcastToEventConnectors` |
| `src/main/managers.ts` | `initTaskNavigation(...)` after the project manager; `taskNavigationManager.dispose()` in `cleanup` |
| `src/main/server/server-controller.ts` | `new TaskNavigationApi().registerRoutes(apiRouter)` |
| `src/main/index.ts` | `setupTaskNavigationIpcHandlers()` after `setupIpcHandlers(...)` |
| `src/main/events-handler.ts` | `prepareTaskNavigationUpdate(task.task, updates)` in `updateTask` |
| `src/main/task/context-manager.ts` | `notifyTaskNavigationContextReplace(...)` as the first line of `setContextMessages` |
| `src/main/task/task.ts` | `replaceContextMessages(messages)`, after `loadContextMessages` |
| `src/renderer/src/utils/hotkeys.ts` | defaults `mod+j`, `mod+shift+f` and `mod+k`; `QUICK_SWITCHER`, `GLOBAL_SEARCH` and `TOPIC_MAP` |
| `src/renderer/src/App.tsx` | `useTaskNavigationHotkeys()`; `<QuickSwitcher />` and `<GlobalSearch />` after `<CommandPalette />` |
| `src/renderer/src/pages/Home.tsx` | `usePendingProjectActivation(...)` |
| `src/renderer/src/components/project/ProjectView.tsx` | `usePendingTaskActivation(projectDir, ...)` |
| `src/renderer/src/components/project/TaskView.tsx` | `usePendingMessageScroll(task.id, ...)`; `<TopicMapModal />` for the active task in the message area |
| `src/renderer/src/components/project/TaskBar.tsx` | `<TopicMapToggleButton />` before the `task-top-bar-right` extension slot |
| `src/renderer/src/components/project/TaskSidebar/TaskItem.tsx` | `<TaskNamePreview />` in place of the task name and its tooltip |
| `src/renderer/src/components/settings/TaskSettings.tsx` | `<TaskNavigationSettings />` after the Tasks section |
| `src/renderer/src/components/settings/HotkeysSettings.tsx` | rows for the three dialog hotkeys |

## Verify

Read-only; run on the Z-Book.

```bash
# 1. The module files, the shared types file and the store exist; the renderer folder holds ten files and the tests folder
cd ~/code/iwd/aider-desk-dev/aider-desk && ls src/main/task-navigation/{task-navigation-manager,summary-model,search-index,message-text,embeddings,task-update,task-navigation-api,ipc,hooks,instance,topic-compaction,topic-compaction-store}.ts packages/common/src/types/task-navigation.ts src/renderer/src/stores/taskNavigationStore.ts | wc -l; ls src/renderer/src/components/task-navigation | wc -l
# 2. Main-process hooks: event bridge, start, dispose, REST routes, IPC handlers, update adjustment
cd ~/code/iwd/aider-desk-dev/aider-desk && for p in "src/main/events/event-manager.ts|notifyTaskNavigationEvent(eventType, data)" "src/main/managers.ts|initTaskNavigation(" "src/main/managers.ts|taskNavigationManager.dispose()" "src/main/server/server-controller.ts|new TaskNavigationApi().registerRoutes(apiRouter)" "src/main/index.ts|setupTaskNavigationIpcHandlers()" "src/main/events-handler.ts|prepareTaskNavigationUpdate(task.task, updates)"; do grep -cF "${p#*|}" "${p%%|*}"; done | paste -sd' '
# 3. Shared contract hooks: type export, hotkey and settings fields, the API methods in the contract, the preload, the browser API and the test mock
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cF "export * from './task-navigation'" packages/common/src/types/index.ts; grep -cE "quickSwitcher: string|globalSearch: string|topicMap: string|taskNavigation\?: Partial<TaskNavigationSettings>" packages/common/src/types/common.ts; grep -cE "^  (searchTasks|getSearchIndexStatus|rebuildSearchIndex|regenerateTaskSummary|previewTopicCompaction|compactTopic|undoTopicCompaction|restoreCompactionArchive):" packages/common/src/api.ts; grep -c "ipcRenderer.invoke('task-navigation-" src/preload/index.ts; grep -c "'/task-navigation/" src/renderer/src/api/browser-api.ts; grep -cE "^    (searchTasks|getSearchIndexStatus|rebuildSearchIndex|regenerateTaskSummary|previewTopicCompaction|compactTopic|undoTopicCompaction|restoreCompactionArchive): vi.fn" src/renderer/src/__tests__/mocks/api.ts; } | paste -sd' '
# 4. Hotkey defaults mod+j, mod+shift+f and mod+k, and their accessors
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -cE "quickSwitcher: 'mod\+j'|globalSearch: 'mod\+shift\+f'|topicMap: 'mod\+k'|QUICK_SWITCHER: dk.quickSwitcher|GLOBAL_SEARCH: dk.globalSearch|TOPIC_MAP: dk.topicMap" src/renderer/src/utils/hotkeys.ts
# 5. Renderer hooks in upstream components
cd ~/code/iwd/aider-desk-dev/aider-desk && for p in "src/renderer/src/App.tsx|useTaskNavigationHotkeys();" "src/renderer/src/App.tsx|<QuickSwitcher />" "src/renderer/src/App.tsx|<GlobalSearch />" "src/renderer/src/pages/Home.tsx|usePendingProjectActivation({" "src/renderer/src/components/project/ProjectView.tsx|usePendingTaskActivation(projectDir" "src/renderer/src/components/project/TaskView.tsx|usePendingMessageScroll(task.id" "src/renderer/src/components/project/TaskView.tsx|<TopicMapModal task=" "src/renderer/src/components/project/TaskBar.tsx|<TopicMapToggleButton />" "src/renderer/src/components/project/TaskSidebar/TaskItem.tsx|<TaskNamePreview " "src/renderer/src/components/settings/TaskSettings.tsx|<TaskNavigationSettings " "src/renderer/src/components/settings/HotkeysSettings.tsx|'dialogHotkeys', 'quickSwitcher'" "src/renderer/src/components/settings/HotkeysSettings.tsx|'dialogHotkeys', 'globalSearch'" "src/renderer/src/components/settings/HotkeysSettings.tsx|'dialogHotkeys', 'topicMap'"; do grep -cF "${p#*|}" "${p%%|*}"; done | paste -sd' '
# 6. Storage and strings: metadata keys, index file name, index tables, the locale block, the hotkey labels
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cE "^  (taskNumber|taskSummary|nameLocked|lastMessagePreview|compactionArchives): '" packages/common/src/types/task-navigation.ts; grep -cF "'task-navigation.db'" src/main/task-navigation/task-navigation-manager.ts; grep -cE "CREATE (VIRTUAL )?TABLE IF NOT EXISTS nav_(tasks|messages|messages_fts|vectors) " src/main/task-navigation/search-index.ts; grep -c '^  "taskNavigation": {' packages/common/src/locales/en.json; grep -cE '"(quickSwitcher|globalSearch|topicMap)": "(Quick Task Switcher|Search All Tasks|Topic Map)"' packages/common/src/locales/en.json; } | paste -sd' '
# 7. Default settings
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -A10 "DEFAULT_TASK_NAVIGATION_SETTINGS: TaskNavigationSettings = {" packages/common/src/types/task-navigation.ts | grep -oE "(autoSummarize|summaryModel|autoRegenerateTitle|searchIndexEnabled|conceptSearchEnabled|quickSwitcherCount|quickSwitcherTopicCount|projectPrefixes): [^,]+" | paste -sd';'
# 8. Behaviour: numbering, topic maps, scanning and embedding in the manager; no tool output indexed; the quick switcher reads renderer memory; the summary model falls back to the task name model; the embedding model; the topic map modal renders into document.body; its view state is stored
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cE "private async (assignTaskNumbers|summarize|scan|embedTask)\(" src/main/task-navigation/task-navigation-manager.ts; grep -cF "message.role === 'tool'" src/main/task-navigation/message-text.ts; grep -cF "useProjectStore((state) => state.projectTasksMap)" src/renderer/src/components/task-navigation/QuickSwitcher.tsx; grep -cF "taskSettings?.taskNameModel" src/main/task-navigation/task-navigation-manager.ts; grep -cF "Xenova/all-MiniLM-L6-v2" src/main/task-navigation/embeddings.ts; grep -cF "document.body)" src/renderer/src/components/task-navigation/TopicMapModal.tsx; grep -cF "TOPIC_MAP_VIEWS_STORAGE_KEY = 'task-navigation-topic-map-views'" src/renderer/src/stores/taskNavigationStore.ts; } | paste -sd' '
# 9. REST routes
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -oE "'/task-navigation/[a-z-]+'" src/main/task-navigation/task-navigation-api.ts | sort | paste -sd' '
# 10. A manual rename locks the title, and a test asserts the prefix derivation
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -cF -e "metadata[lockKey] = true" -e "deriveProjectPrefix('/home/user/code/aider-desk-dev')).toBe('ADD')" src/main/task-navigation/task-update.ts src/main/task-navigation/__tests__/task-update.test.ts
# 11. Topic sections: the TaskTopic fields and the section type, the sectioning prompt and its two thresholds, the modal's row builder, and the call in the manager
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cE "^  (sections\?: TaskTopicSection\[\]|sectioned\?: boolean);$" packages/common/src/types/task-navigation.ts; grep -c "^export interface TaskTopicSection {" packages/common/src/types/task-navigation.ts; grep -cE "^export const (SECTION_SYSTEM_PROMPT|MIN_SECTIONED_TOPIC_MESSAGES|MAX_SECTION_MESSAGES) =" src/main/task-navigation/summary-model.ts; grep -cE "^export const (buildTopicMapRows|isNavigableRow) =" src/renderer/src/components/task-navigation/topic-map-rows.ts; grep -cF "await sectionTopics(" src/main/task-navigation/task-navigation-manager.ts; } | paste -sd' '
# 12. Compaction hooks: the context-replace call in ContextManager, the Task method, and the bridge file without imports
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cF "notifyTaskNavigationContextReplace(this.task.getProjectDir(), this.taskId, this.messages, contextMessages);" src/main/task/context-manager.ts; grep -cF "public async replaceContextMessages(messages: ContextMessage[]): Promise<void> {" src/main/task/task.ts; grep -c "^import" src/main/task-navigation/hooks.ts; } | paste -sd' '
# 13. Compaction types and storage: the shared names, the compaction fields, the managed metadata key, the folder and archive prefix, the scroll_target migration, the system prompt
cd ~/code/iwd/aider-desk-dev/aider-desk && { grep -cE "^export (const|interface|type) (TOPIC_COMPACTION_ID_PREFIX|TOPIC_COMPACTION_LEVELS|DEFAULT_TOPIC_COMPACTION_LEVEL|TopicCompactionTarget|TopicCompactionOptions|TopicCompactionBlockReason|TopicCompactionPreview|TopicCompactionInfo|CompactionArchiveInfo|getCompactionSummaryMessageId|getCompactionPromptMessageId|isTopicCompactionMessageId|isTopicCompactionPromptMessageId|getTopicCompactionIdFromMessageId|getCompactionTargetCharacters)\b" packages/common/src/types/task-navigation.ts; grep -c "^  compaction?: TopicCompactionInfo;$" packages/common/src/types/task-navigation.ts; grep -cF "TASK_NAVIGATION_METADATA_KEYS.compactionArchives," src/main/task-navigation/task-update.ts; grep -cE "^export const (TOPIC_COMPACTIONS_DIR = 'topic-compactions'|COMPACTION_ARCHIVE_PREFIX = 'archive-');" src/main/task-navigation/topic-compaction-store.ts; grep -cF "ALTER TABLE nav_messages ADD COLUMN scroll_target TEXT" src/main/task-navigation/search-index.ts; grep -c "^export const COMPACTION_SYSTEM_PROMPT = " src/main/task-navigation/topic-compaction.ts; } | paste -sd' '
# 14. Compaction IPC channels and REST routes
cd ~/code/iwd/aider-desk-dev/aider-desk && grep -oE "'task-navigation-compaction-[a-z-]+'" src/main/task-navigation/ipc.ts | sort | paste -sd' '; grep -oE "'/task-navigation/compaction/[a-z-]+'" src/main/task-navigation/task-navigation-api.ts | sort | paste -sd' '
```

**Expected**

1. `14`, then `11`.
2. `1 1 1 1 1 1`
3. `1 4 8 8 8 8`
4. `6`
5. `1 1 1 1 1 1 1 1 1 1 1 1 1`
6. `5 1 4 1 3`
7. `autoSummarize: true;summaryModel: null;autoRegenerateTitle: true;searchIndexEnabled: true;conceptSearchEnabled: true;quickSwitcherCount: 6;quickSwitcherTopicCount: 1;projectPrefixes: {}`
8. `4 1 1 1 1 1 1`
9. `'/task-navigation/index-status' '/task-navigation/rebuild-index' '/task-navigation/regenerate-summary' '/task-navigation/search'`
10. `src/main/task-navigation/task-update.ts:1` and `src/main/task-navigation/__tests__/task-update.test.ts:1`
11. `2 1 3 2 1`
12. `1 1 0`
13. `15 2 1 2 1 1`
14. `'task-navigation-compaction-compact' 'task-navigation-compaction-preview' 'task-navigation-compaction-restore-archive' 'task-navigation-compaction-undo'`, then `'/task-navigation/compaction/compact' '/task-navigation/compaction/preview' '/task-navigation/compaction/restore-archive' '/task-navigation/compaction/undo'`

**Manual checks:** none.
