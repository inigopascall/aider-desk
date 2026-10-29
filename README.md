# AiderDesk: the Inigo Fork

This is a fork of [AiderDesk](https://github.com/hotovo/aider-desk), the desktop and browser app for working with AI coding agents. It keeps up with upstream releases and adds tools for people who run long, serious sessions with agents: finding your way around big conversations, seeing exactly what the model is being sent, and handing whole jobs to a team of agents.

For installation and everything else AiderDesk does, see the [upstream project](https://github.com/hotovo/aider-desk) and its [documentation](https://aiderdesk.hotovo.com/docs).

## Find your way around long conversations

**Topic map.** As a conversation grows, AiderDesk sorts it into topics, splits each finished topic into short titled sections, and keeps a plain-language summary of the whole task at the top. Open the map from the task bar to see the shape of a long session at a glance, then jump straight to any message.

**Tasks that name themselves.** A task's title keeps up with what the conversation is about now, not what you typed first. Rename a task yourself and it stays renamed. Want a fresh title? One click.

**Search everything.** One search box covers every conversation in every project, open or not. It matches your exact words, and can also find related wording using a small model that runs on your own machine.

**Quick switcher.** A keystroke brings up your recent tasks with their latest topics, their last message and what any running task is doing right now. Sub-tasks show their parent, so you always know where you are.

**Task keys.** Every task gets a short number, like `ADD-048`, so you can refer to it in a note, a commit or another conversation.

**Bookmarks.** Bookmark any message. A slim map down the side of the conversation shows your bookmarks and takes you from one to the next.

## See what the model is actually being sent

**Context usage bar.** A coloured bar shows what is filling the model's context window: the system prompt, rules, tool definitions, repository maps, files and the conversation itself. Hover over any part to see what it is and how big it is; click a piece of the conversation to jump to it. A marker shows where automatic compaction will kick in.

**Context Files pane.** Everything the agent will receive (rules, repository maps and files) is listed in one place, in the order the model receives it, each with a bar showing its size. Untick anything to hold it back without removing it, and see at a glance what isn't being sent, and why.

**Topic sizes.** The topic map shows how much of the context each topic takes up, worked out locally at no cost.

**Reasoning and temperature, in plain sight.** Both sit right next to the model picker and show the value actually being used and where it comes from, for example `Medium · agent profile`. Change either one for just this task.

## Keep conversations lean without losing anything

**Compact a topic.** Squeeze any finished topic, or one section of it, into a short recap, at a level of detail you choose, from a couple of sentences to a detailed digest. The original messages are kept, stay searchable, and come back with one click.

**`/hone`.** Turn a long design discussion into a short document of what was actually decided, leaving out the back-and-forth and the ideas that were dropped. `/hone 5` keeps the last five messages untouched.

## Give agents the background they need

**Repository mappings.** AiderDesk writes reference files about your project, keeps them up to date as the code changes, and gives them to the agent as background:

- a **codebase outline**: every source folder with its files, each folder described in a line;
- for **Laravel** projects, the database schema, models and routes, read from the running app, even when it runs on another machine.

A size budget stops them crowding out everything else.

## Hand a whole job to a team of agents

**Workflows.** Pick a workflow, type your request, and a team of specialist agents takes it from there. One gathers evidence from the code and the web, a planner writes the plan, the plan is split into one job per file, editor agents carry those jobs out side by side, and a final agent checks the result against the plan and reports back. **Dev Pipeline + Review** adds reviewers and an arbiter who can send work back for correction.

Every batch of edits is committed to git, so each step can be inspected or undone. For each role you choose a main and a fallback model, and you can set a check to run after every batch of edits (tests or a type check, say), a final command, and how many editors run at once.

> Workflows need agent profiles that are not included: one per role, stored in `~/.aider-desk/workflow-agents/` and named after the role. The workflow's settings window lists the roles.

## Nicer to work in

- **A proper prompt editor.** Markdown is formatted as you type, Obsidian-style. Drag it taller, cycle through sizes, or expand it to fill the window for long prompts.
- **Agent prompts as markdown files.** Each agent profile's prompts live in their own markdown files, editable in the app or in any text editor, and easy to keep under version control.
- **Sub-subtasks.** Let subtasks have subtasks of their own, for three levels of nesting.
- **A calmer interface.** Animations are off by default, and a small blinking dot shows which tasks are still working. Easier on slow machines and remote connections.

## Building from source

You need Node.js 22.

```bash
npm install
npm run build:unpack     # desktop app
npm run build:server     # headless server
```

## Licence

Same as upstream; see [LICENSE](LICENSE).
