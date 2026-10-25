import { Router } from 'express';
import { z } from 'zod';

import { BaseApi } from './base-api';

import { EventsHandler } from '@/events-handler';
import { ProjectManager } from '@/project';

const ContextFileSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  path: z.string().min(1, 'File path is required'),
  readOnly: z.boolean().optional(),
});

const GetContextFilesSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
});

const GetAddableFilesSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  searchRegex: z.string().optional(),
});

const GetAllFilesSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  useGit: z.boolean().optional(),
});

const GetUpdatedFilesSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
});

const GetUpdatedFileDiffSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  filePath: z.string().min(1, 'File path is required'),
  commitHash: z.string().optional(),
  previousPath: z.string().min(1).optional(),
});

const RefreshContextFilesSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
});

const SetContextFilesDisabledSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  paths: z.array(z.string().min(1, 'File path is required')).min(1, 'At least one file path is required'),
  disabled: z.boolean(),
});

const SetTaskFileSelectionSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  section: z.enum(['rules', 'mappings', 'files']),
  paths: z.array(z.string().min(1, 'File path is required')).min(1, 'At least one file path is required'),
  selected: z.boolean(),
});

const GetTaskContextManifestSchema = z.object({
  projectDir: z.string().min(1, 'Project directory is required'),
  taskId: z.string().min(1, 'Task ID is required'),
});

export class ContextApi extends BaseApi {
  constructor(
    private readonly projectManager: ProjectManager,
    private readonly eventsHandler: EventsHandler,
  ) {
    super();
  }

  registerRoutes(router: Router): void {
    // Add context file
    router.post(
      '/add-context-file',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(ContextFileSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, path, readOnly } = parsed;
        const added = await this.eventsHandler.addFile(projectDir, taskId, path, readOnly);
        res.status(200).json({ added });
      }),
    );

    // Drop context file
    router.post(
      '/drop-context-file',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(ContextFileSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, path } = parsed;
        this.eventsHandler.dropFile(projectDir, taskId, path);
        res.status(200).json({ message: 'File dropped from context' });
      }),
    );

    // Set context files disabled state
    router.post(
      '/set-context-files-disabled',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(SetContextFilesDisabledSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, paths, disabled } = parsed;
        await this.eventsHandler.setContextFilesDisabled(projectDir, taskId, paths, disabled);
        res.status(200).json({ message: 'Context files updated' });
      }),
    );

    // Tick or untick files in one section of a task's context selection
    router.post(
      '/set-task-file-selection',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(SetTaskFileSelectionSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, section, paths, selected } = parsed;
        await this.eventsHandler.setTaskFileSelection(projectDir, taskId, section, paths, selected);
        res.status(200).json({ message: 'Task file selection updated' });
      }),
    );

    // Get the task's context manifest
    router.post(
      '/get-task-context-manifest',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetTaskContextManifestSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId } = parsed;
        const manifest = await this.eventsHandler.getTaskContextManifest(projectDir, taskId);
        res.status(200).json(manifest);
      }),
    );

    // Get context files
    router.post(
      '/get-context-files',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetContextFilesSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId } = parsed;
        const project = this.projectManager.getProject(projectDir);
        const validatedProject = this.findProject(project, projectDir, res);
        if (!validatedProject) {
          return;
        }

        const task = validatedProject.getTask(taskId);
        const contextFiles = task ? await task.getContextFiles() : [];
        res.status(200).json(contextFiles);
      }),
    );

    // Get addable files
    router.post(
      '/get-addable-files',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetAddableFilesSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, searchRegex } = parsed;
        const addableFiles = await this.eventsHandler.getAddableFiles(projectDir, taskId, searchRegex);
        res.status(200).json(addableFiles);
      }),
    );

    router.post(
      '/get-all-files',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetAllFilesSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, useGit } = parsed;
        const allFiles = await this.eventsHandler.getAllFiles(projectDir, taskId, useGit);
        res.status(200).json(allFiles);
      }),
    );

    router.post(
      '/get-updated-files',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetUpdatedFilesSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId } = parsed;
        const updatedFiles = await this.eventsHandler.getUpdatedFiles(projectDir, taskId);
        res.status(200).json(updatedFiles);
      }),
    );

    router.post(
      '/get-updated-file-diff',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetUpdatedFileDiffSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, filePath, commitHash, previousPath } = parsed;
        const diff = await this.eventsHandler.getUpdatedFileDiff(projectDir, taskId, filePath, commitHash, previousPath);
        res.status(200).json({ diff });
      }),
    );

    router.post(
      '/get-updated-file-contents',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(GetUpdatedFileDiffSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId, filePath, commitHash, previousPath } = parsed;
        const contents = await this.eventsHandler.getUpdatedFileContents(projectDir, taskId, filePath, commitHash, previousPath);
        res.status(200).json(contents);
      }),
    );

    router.post(
      '/refresh-context-files',
      this.handleRequest(async (req, res) => {
        const parsed = this.validateRequest(RefreshContextFilesSchema, req.body, res);
        if (!parsed) {
          return;
        }

        const { projectDir, taskId } = parsed;
        await this.eventsHandler.refreshContextFiles(projectDir, taskId);
        res.status(200).json({ message: 'Context files refreshed' });
      }),
    );
  }
}
