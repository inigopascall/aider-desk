# AiderDesk: the Inigo Fork

This is a fork of [AiderDesk](https://github.com/hotovo/aider-desk), the desktop and browser app for working with AI coding agents. It tracks upstream releases and adds the features below. For everything else, including installation and general use, see the [upstream project](https://github.com/hotovo/aider-desk) and its [documentation](https://aiderdesk.hotovo.com/docs).

## What this fork adds

### Workflows

A workflow hands a coding request to a team of specialist agents instead of one. You pick a workflow from the selector in the task bar, type your request, and the agents take it from there:

1. One agent decides whether there is enough information to start, and sends others to look through the code or search the web until there is.
2. A planner writes an implementation plan.
3. A decompositor splits the plan into one job per file.
4. Editor agents carry out those jobs, several at once where the files don't depend on each other.
5. A confirmer checks the result against the plan and writes a report.

Two workflows are included:

- **Dev Pipeline**: the steps above.
- **Dev Pipeline + Review**: the same, plus optional reviewers and an arbiter who can send edits back for correction, up to four rounds.

Each project turns workflows on or off under **Settings → Workflows**. There you can also give each agent role a main model and a fallback model, set a command to run after edits (tests or a linter, say), and limit how many editors run at once. Every batch of edits is committed to git, so each step can be inspected or undone.

> **Workflows need agent profiles that are not included.** Each role runs as an agent profile stored in `~/.aider-desk/workflow-agents/`, and the profile's name must match the role: `DIGESTER`, `INVESTIGATOR`, `RESEARCHER`, `GRAND-PLANNER`, `DECOMPOSITOR`, `EDITOR` and `CONFIRMER`, plus `REVIEWER-1`, `REVIEWER-2` and `ARBITER` for the review workflow. Each needs subagents enabled. Without them, a workflow stops at its first step with a message naming the missing agent.

### A bigger prompt editor

The prompt box opens into a full-size editor for long prompts. It shows your markdown formatted as you type, or switches to plain text. It can stretch to the full window width, and Ctrl + mouse wheel changes the text size.

### Agent prompts as markdown files

An agent profile's system prompt, custom instructions and subagent description are kept as separate markdown files next to its settings, not inside them. They can be edited in the app or in any text editor, and they are easy to keep under version control.

### Repository mappings

A project can generate reference files into `.aider-desk/mappings/`, for example a map of the codebase or a list of database models. The script that produces them is `.aider-desk/mappings.sh` in the project. When an agent profile has **Include repository mappings** turned on, those files are given to the agent as read-only background.

### Switching context files off without removing them

Each file in a task's context has a checkbox. Unticking it hides the file from the agent but keeps it in the list, so it can be switched back on later.

### Bookmarks and thread outline

Any message can be bookmarked. A thread outline lists the conversation's prompts and bookmarks, and clicking an entry jumps to that message.

### `/hone`

Type `/hone` to turn a long design discussion into a short document of what was actually decided, leaving out the back-and-forth and the ideas that were dropped. `/hone 5` keeps the last five messages untouched.

### Sub-subtasks

With **Settings → Tasks → Allow Sub-Subtasks**, a subtask can have subtasks of its own, giving three levels.

### Quieter interface

**Disable CSS animations** (in the message display settings) turns off the interface's animations and spinners. A small blinking dot shows which tasks are still working. This helps on slow machines and over remote connections.

## Building from source

You need Node.js 22.

```bash
npm install
npm run build:unpack     # desktop app
npm run build:server     # headless server
```

## Licence

Same as upstream; see [LICENSE](LICENSE).
