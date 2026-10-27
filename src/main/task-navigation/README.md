---
verified: 2026-10-27
verified_by: workhorse
---

# Task navigation

Task keys, rolling topic maps, global search and a quick task switcher for AiderDesk. The main-process code is in this directory; the renderer code is in `src/renderer/src/components/task-navigation/`. Upstream files change only at the hooks listed under *Hooks in upstream files*, so an upstream merge can conflict only at those lines.

## Features

| Feature | What the code does |
|---|---|
| Task keys | Numbers every saved task of an open project, oldest first, and gives a new number to a task that shares one, such as a duplicated or forked task. A key is `PREFIX-NNN`, for example `ADD-048`. The prefix is the initials of the project folder name (`aider-desk-dev` gives `ADD`) unless it is overridden in Settings → Tasks → Task Navigation. |
| Topic maps | When a prompt finishes, sends the task's topic map and the user and assistant messages it does not yet cover to the summary model, and merges the model's JSON reply into the map. Only the current topic, the last topic still in the conversation, grows: a new message joins it or starts a new topic, never an earlier one. `applySummaryUpdate` redirects an assignment to an earlier topic and ignores summary changes to earlier topics, so a finished topic is final. Renames the task to the map's title unless the user renamed it by hand. The same reply carries a plain-language description of the whole task, kept in `TaskSummary.description` and rewritten at each update; `TaskDescription` in `TaskSummaryPreview.tsx` shows it above the topics in the topic map modal, the quick switcher and the sidebar preview. |
| Context estimates | `getTaskTopicEstimates` estimates topic context occupancy and billing without calling a model; occupancy is not billing, and estimate calculation has no model cost. Separately, compaction generation runs in parallel for disjoint topics, then commits serialized, validated results; overlapping work is blocked. Live recaps are used, not archives. Automatic map updates are deferred. |
| Topic sections | When a topic closes because a newer topic started, `sectionTopics` in `summary-model.ts` asks the summary model, with `SECTION_SYSTEM_PROMPT`, to divide it into sections: one-line titles over runs of its messages, stored in `TaskTopic.sections`. A topic of more than `MAX_SECTION_MESSAGES` messages must be divided so that no section holds more; an answer that breaks the rules is retried once. A topic with fewer than `MIN_SECTIONED_TOPIC_MESSAGES` messages in the conversation is marked done without a model call. `TaskTopic.sectioned` is `true` once sectioning is done or skipped, and `false` while it is pending: when a model call fails, that topic and every candidate not yet tried are set to `false` and retried at the next update. The current topic has no sections. A rebuild sections every finished topic; finished topics of maps made before sections existed are left as they are. |
| Topic compaction | `previewTopicCompaction`, `compactTopic`, `undoTopicCompaction` and `restoreCompactionArchive` in `task-navigation-manager.ts` compact a finished topic, or a section of one, into one recap at a chosen level of detail, and put it back. `topic-compaction.ts` locates the stretch of stored messages the target covers, and refuses a target that is the current topic, detached, not one run of messages, too short, already compacted or inside a compacted topic, or whose stretch would split a tool call from its result; each refusal is a `TopicCompactionBlockReason`. The topic map model writes the recap with `COMPACTION_SYSTEM_PROMPT`; the target length per level is `getCompactionTargetCharacters`. The original messages are written to a sidecar file first; then the stretch is replaced by a marker (`topic-compaction-<id>-prompt`) and the recap (`topic-compaction-<id>`) through `Task.replaceContextMessages`, which, like smart compaction, also clears the task's workflow event log. The record goes to `TaskTopic.compaction` or `TaskTopicSection.compaction`; `messageIds` and `startMessageId` keep the original ids. Nothing changes while the task is running, or when the stretch changed while the recap was written. Undo puts the original messages back wherever the pair now sits. Topic maps, sections and previews never see the pair. A rebuild keeps every topic up to the last one that holds a compaction record. |
| Safeguard against built-in compaction | `ContextManager.setContextMessages` reports every replacement of a conversation through `hooks.ts`. When a replacement the manager did not make removes a recap (`findRemovedCompactionSummaries`), the previous conversation is archived in the task folder; after `/compact` has cleared the task metadata, the task navigation keys are put back, the archive is listed under `compactionArchives`, and records whose recap is gone become `lost`. `reconcileCompactions` runs after every topic map update, archive and restore: a record whose original messages are back, for example after the built-in undo, is dropped with its sidecar. Restoring an archive first archives the current conversation. Smart compaction keeps message ids, so it never archives. |
| Topic map modal | Opens from the task bar button or the topic map hotkey, for the active task only, and stays open without automatic scrolling when map data changes. ↑↓ move through the topics and the messages of expanded topics; in an expanded topic, each section title is a header row above the section's first message, which the keys and the mouse skip. Enter expands or collapses a topic, and on a message closes the modal and scrolls to it. Shift+Enter, or the header button, collapses every topic when any is expanded and otherwise expands them all. Each topic's arrow sits in a circle; in an expanded topic with sections, a connector drawn by `TopicConnector.tsx` from the pieces that `getTopicConnectorParts` in `topic-map-rows.ts` assigns to each row runs from the circle down to each section title. The selected row and the expanded topics are remembered per task. |
| Compaction in the renderer | In the topic map modal, a topic row or a section title shows a compact button when the client judges the target compactable (`isCompactableFromClient` in `compaction-utils.ts`; the engine's preview has the final word), and a "compacted" tag with Undo on a compacted one. `c` compacts the selected topic, or the section that holds the selected message or recap; `u` undoes a compacted topic or a recap. The options panel (`TopicCompactionPanel.tsx`) docks at the bottom of the modal: it previews the target, offers the five levels with word estimates and optional instructions, and remembers the last level. While the recap is written, `applyTopicCompactionView` in `compaction-view.ts`, called from `useProcessedMessages`, shows the stretch as one placeholder whose id starts with `task-navigation-compacting-`; it always hides the compaction markers. Pending stretches live in `taskNavigationStore.ts` and are not persisted. `MessageBlock` hands recaps and placeholders to `renderTopicCompactionMessage` in `TopicCompactionMessage.tsx`: a recap is one AI message without remove or fork, with a badge and Undo. Expanded, a compacted topic or section shows one recap row (`buildTopicMapRows`); the row of a lost recap can't be opened. When the task has compaction archives, the modal header lists them and restores one after a confirmation. `/compact` and `/hone` ask first when the task has compaction records (`useBuiltInCompactionGuard` in `BuiltInCompactionGuard.tsx`, with `taskHasTopicCompactions`). Every compaction action is disabled while the task is running. |
| Global search | Keeps an SQLite FTS5 index of the user and assistant text of every task in every project, including tool names and arguments but not tool output, and local sentence vectors (`Xenova/all-MiniLM-L6-v2`) of task titles, topics and prompts for concept matches. Results are ordered by best match, or by the task's last update (Tab in the overlay). The original messages of topic compactions in effect are indexed from their sidecars; a hit on one points at the outermost recap in the conversation (`scroll_target`). |
| Quick switcher | Lists the most recently updated tasks of the open projects from renderer memory, with their latest topics, their last message and, for a running task, its current activity. A sub-task has a line above it naming its parent, found in the same project, left-aligned with its own title and joined to it by a connector (`ParentConnector`); the parent line is part of the sub-task's row and opens the sub-task. |

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
| Topic map modal state, search order and the last compaction level | The renderer's `localStorage`, written by `taskNavigationStore.ts`. |
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
| `topic-estimates.ts` | Topic context occupancy and billing estimates without model calls |
| `task-navigation-api.ts`, `ipc.ts` | REST routes under `/api/task-navigation/`, and the Electron IPC handlers, including `getTaskTopicEstimates` |
| `hooks.ts`, `instance.ts` | The event bridge from `EventManager`, and the manager instance |

Shared types and helpers are in `packages/common/src/types/task-navigation.ts`. Strings are in the `taskNavigation` block of `packages/common/src/locales/en.json`. The topic map modal's rows, including the display-only section rows, are built by `buildTopicMapRows` in `src/renderer/src/components/task-navigation/topic-map-rows.ts`.

## Hooks in upstream files

After an upstream merge, check that each of these is still present.

| File | Hook |
|---|---|
| `packages/common/src/types/index.ts` | `export * from './task-navigation'` |
| `packages/common/src/types/common.ts` | `HotkeyConfig.dialogHotkeys.quickSwitcher`, `globalSearch` and `topicMap`; `SettingsData.taskNavigation` |
| `packages/common/src/api.ts` | `searchTasks`, `getSearchIndexStatus`, `rebuildSearchIndex`, `regenerateTaskSummary`, `getTaskTopicEstimates`, `previewTopicCompaction`, `compactTopic`, `undoTopicCompaction`, `restoreCompactionArchive` |
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
| `src/renderer/src/hooks/useProcessedMessages.ts` | `useTopicCompactionView(messages)` before grouping |
| `src/renderer/src/components/message/MessageBlock.tsx` | `renderTopicCompactionMessage(...)` at the start of the response branch |
| `src/renderer/src/components/PromptField/PromptField.tsx` | `useBuiltInCompactionGuard(baseDir, taskId)`; `/compact` and `/hone` run through `guardBuiltInCompaction`; `{builtInCompactionDialog}` in the returned markup |
| `src/renderer/src/components/project/TaskSidebar/TaskItem.tsx` | `<TaskNamePreview />` in place of the task name and its tooltip |
| `src/renderer/src/components/settings/TaskSettings.tsx` | `<TaskNavigationSettings />` after the Tasks section |
| `src/renderer/src/components/settings/HotkeysSettings.tsx` | rows for the three dialog hotkeys |

## Verify

Read-only structural checks on the Z-Book. Behaviour is covered by the tests beside the implementations.

```bash
(
cd ~/code/iwd/aider-desk-dev/aider-desk || exit 1
failed=0
check() { if grep -qF "$3" "$2"; then printf '%s: OK\n' "$1"; else printf '%s: FAIL\n' "$1"; failed=1; fi; }
check 'token aggregation helper' src/main/task-navigation/topic-estimates.ts 'export const estimateTaskTopics ='
check 'shared local tokenizer' src/main/task-navigation/topic-estimates.ts "import { estimateMessageTokens } from '@/agent/utils';"
check 'estimate API contract' packages/common/src/api.ts 'getTaskTopicEstimates:'
check 'estimate preload' src/preload/index.ts "'task-navigation-topic-estimates'"
check 'estimate browser transport' src/renderer/src/api/browser-api.ts "'/task-navigation/topic-estimates'"
check 'estimate IPC' src/main/task-navigation/ipc.ts "'task-navigation-topic-estimates'"
check 'estimate REST' src/main/task-navigation/task-navigation-api.ts "'/task-navigation/topic-estimates'"
check 'estimate mock' src/renderer/src/__tests__/mocks/api.ts 'getTaskTopicEstimates: vi.fn'
check 'compaction reservations' src/main/task-navigation/task-navigation-manager.ts 'compactionReservations'
check 'deferred topic-map updates' src/main/task-navigation/task-navigation-manager.ts 'deferredCompactionSummaries'
check 'context replacement bridge' src/main/task/context-manager.ts 'notifyTaskNavigationContextReplace(this.task.getProjectDir(), this.taskId, this.messages, contextMessages);'
check 'modal returns to list on start' src/renderer/src/components/task-navigation/TopicMapModal.tsx 'onStarted={closeBottomPanel}'
check 'target progress identity' src/renderer/src/components/task-navigation/compaction-utils.ts 'getPendingTargetState'
check 'compaction token preview' src/renderer/src/components/task-navigation/TopicCompactionPanel.tsx 'formatTopicTokenCount(preview.sourceTokens)'
check 'conversation placeholder projection' src/renderer/src/hooks/useProcessedMessages.ts 'useTopicCompactionView(messages)'
check 'recap rendering hook' src/renderer/src/components/message/MessageBlock.tsx 'renderTopicCompactionMessage({'
exit "$failed"
)
```

Expected: every line ends in `OK`, and exit status is zero. No manual checks are required for these structural claims.

