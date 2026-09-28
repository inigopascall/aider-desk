---
title: "Aider Tools"
sidebar_label: "Aider Tools"
verified: 2026-09-28
verified_by: workhorse
---

# Aider Tools

When **Agent Mode** is active, the agent can interact with the underlying Aider instance using a dedicated set of tools. This allows the agent to leverage Aider's powerful code generation and modification capabilities as part of a larger, autonomous task.

These tools can be enabled or disabled for each Agent Profile in **Settings > Agent**.

## Available Aider Tools

#### `get_context_files`
**Description**: Allows the agent to see a list of all files currently included in Aider's context. This helps the agent understand what information Aider will use before running a prompt.

#### `add_context_files`
**Description**: Adds one or more existing files or folders to Aider's context. The agent should use this tool to provide Aider with all relevant files before requesting code changes. Every path must already exist: the tool never creates files. A path that does not exist is rejected with an error returned to the agent, and a warning is shown in the task. A relative path is resolved against the task directory only, so a file outside the task directory, including a file in another project, must be given as an absolute path; a relative path that climbs out of the task directory with `../` is rejected. Relative paths are used for files to edit and absolute paths for read-only references; a read-only flag can also be set explicitly for all passed paths.

#### `drop_context_files`
**Description**: Removes one or more files from Aider's context. This is useful for cleaning up the context after a specific sub-task is complete, helping to manage token usage.

#### `run_prompt`
**Description**: This is the primary tool for delegating a coding task to Aider. The agent can provide a natural language prompt describing what needs to be done (e.g., "Refactor this function to be more efficient," "Add a new method to this class"). Aider will then execute the task on the files currently in its context.

## Verify

Read-only; run on the Z-Book.

```bash
# 1. add_context_files contains no file-creation code
grep -cE 'writeFile|mkdir|addToGit' ~/code/iwd/aider-desk-dev/aider-desk/src/main/agent/tools/aider.ts
# 2. Missing paths and relative paths that escape the task directory are rejected, each with a warning in the task
grep -c "'warning'" ~/code/iwd/aider-desk-dev/aider-desk/src/main/agent/tools/aider.ts; grep -oE 'escapesTaskDir|resolveContextFilePath' ~/code/iwd/aider-desk-dev/aider-desk/src/main/agent/tools/aider.ts | sort -u
# 3. The tool description tells the agent that paths must exist and that outside files need absolute paths
grep -c 'This tool never creates files' ~/code/iwd/aider-desk-dev/aider-desk/packages/common/src/tools.ts; grep -c 'pass its full absolute path' ~/code/iwd/aider-desk-dev/aider-desk/packages/common/src/tools.ts
# 4. The tool's tests exist
grep -c '^  it(' ~/code/iwd/aider-desk-dev/aider-desk/src/main/agent/tools/__tests__/aider.test.ts
```

**Expected**

1. `0`.
2. `2`; then `escapesTaskDir` and `resolveContextFilePath`.
3. `1`; `1`.
4. `8`.
