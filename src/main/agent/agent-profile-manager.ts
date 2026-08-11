import * as fs from 'fs/promises';
import * as path from 'path';

import { FSWatcher, watch } from 'chokidar';
import { debounce } from 'lodash';
import { DEFAULT_AGENT_PROFILE, DEFAULT_AGENT_PROFILES } from '@common/agent';
import { fileExists } from '@common/utils';
import { v4 as uuidv4 } from 'uuid';

import type { AgentProfile, SettingsData } from '@common/types';
import type { Store } from '@/store';

import { Project } from '@/project';
import { ExtensionManager, ExtensionsChangeListener } from '@/extensions/extension-manager';
import { AIDER_DESK_AGENTS_DIR, AIDER_DESK_HOME_DIR, AIDER_DESK_RULES_DIR } from '@/constants';
import logger from '@/logger';
import { EventManager } from '@/events';
import { deriveDirName } from '@/utils';
import { shouldUsePolling } from '@/utils/file-watch';

// Helper methods for directory management
const getGlobalAgentsDir = (): string => path.join(AIDER_DESK_HOME_DIR, 'agents');
const getProjectAgentsDir = (projectDir: string): string => path.join(projectDir, AIDER_DESK_AGENTS_DIR);
const getWorkflowAgentsDir = (): string => path.join(AIDER_DESK_HOME_DIR, 'workflow-agents');
const getAgentsDirForProfile = (profile: AgentProfile): string =>
  profile.workflowAgent
    ? getWorkflowAgentsDir()
    : profile.projectDir
      ? getProjectAgentsDir(profile.projectDir)
      : getGlobalAgentsDir();

// Helper methods for rule file discovery
const getAgentRulesDir = (agentsDir: string, agentDirName: string): string => path.join(agentsDir, agentDirName, AIDER_DESK_RULES_DIR);

const getRuleFilesForAgent = async (agentDirName: string, agentsDir: string): Promise<string[]> => {
  const rulesDir = getAgentRulesDir(agentsDir, agentDirName);
  const ruleFiles: string[] = [];

  try {
    await fs.access(rulesDir);
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        ruleFiles.push(path.join(rulesDir, entry.name));
      }
    }
  } catch {
    // Rules directory doesn't exist or can't be read
  }

  return ruleFiles;
};

const getAllRuleFilesForProfile = async (profile: AgentProfile, dirName: string): Promise<string[]> => {
  const ruleFiles: string[] = [];

  // Get rule files from the profile's own directory
  const agentsDir = getAgentsDirForProfile(profile);
  const profileRuleFiles = await getRuleFilesForAgent(dirName, agentsDir);
  ruleFiles.push(...profileRuleFiles);

  // If this is a project-level profile, also check for global profile with same ID
  if (profile.projectDir) {
    const globalAgentsDir = getGlobalAgentsDir();
    const globalRuleFiles = await getRuleFilesForAgent(dirName, globalAgentsDir);
    ruleFiles.push(...globalRuleFiles);
  }

  return ruleFiles;
};

interface AgentProfileContext {
  dirName: string;
  order: number;
  agentProfile: AgentProfile;
}

export class AgentProfileManager {
  // Single profiles map - the core simplification
  private profiles: Map<string, AgentProfileContext> = new Map();

  // Directory watching (one watcher per directory)
  private directoryWatchers: Map<string, FSWatcher> = new Map(); // agentsDir → watcher

  // Listener for extension changes
  private extensionsChangeListener: ExtensionsChangeListener;

  constructor(
    private readonly eventManager: EventManager,
    private readonly extensionManager: ExtensionManager,
    private readonly store: Store,
  ) {
    this.extensionsChangeListener = () => {
      this.sendAgentProfilesUpdated();
    };
  }

  public async init(): Promise<void> {
    await this.initializeProfiles();
    await this.initializeWorkflowAgents();
    await this.setupGlobalFileWatcher();
    await this.setupWatcherForDirectory(getWorkflowAgentsDir());
    this.extensionManager.addListener(this.extensionsChangeListener);
    this.sendAgentProfilesUpdated();
  }

  public async initializeForProject(projectDir: string): Promise<void> {
    logger.debug(`Initializing agent profiles for project: ${projectDir}`);

    const projectAgentsDir = getProjectAgentsDir(projectDir);

    // Load project-specific profiles
    await this.loadProfilesFromDirectory(projectAgentsDir);

    // Setup file watcher for project directory
    await this.setupWatcherForDirectory(projectAgentsDir);

    this.sendAgentProfilesUpdated();
  }

  public removeProject(projectDir: string): void {
    logger.debug(`Removing agent profiles for project: ${projectDir}`);

    const projectAgentsDir = getProjectAgentsDir(projectDir);

    // Remove project profiles from the main profiles map
    const profilesToRemove: string[] = [];
    for (const [profileId, context] of this.profiles.entries()) {
      if (context.agentProfile.projectDir === projectDir) {
        profilesToRemove.push(profileId);
      }
    }

    profilesToRemove.forEach((profileId) => this.profiles.delete(profileId));

    // Clean up directory watcher
    const watcher = this.directoryWatchers.get(projectAgentsDir);
    if (watcher) {
      void watcher.close();
      this.directoryWatchers.delete(projectAgentsDir);
    }
  }

  public sendAgentProfilesUpdated(): void {
    const allProfiles = this.getAllProfiles();
    this.eventManager.sendAgentProfilesUpdated(allProfiles);
  }

  private async initializeProfiles(ensureDefaults = true): Promise<void> {
    logger.debug('Initializing agent profiles...');
    this.profiles.clear();

    const globalAgentsDir = getGlobalAgentsDir();
    if (ensureDefaults) {
      // Ensure default profiles exist in global directory
      await this.ensureDefaultProfiles(globalAgentsDir);
    }

    // Load global profiles
    await this.loadProfilesFromDirectory(globalAgentsDir);

    this.sendAgentProfilesUpdated();
  }

  private async initializeWorkflowAgents(): Promise<void> {
    const dir = getWorkflowAgentsDir();
    await fs.mkdir(dir, { recursive: true }); // ensure exists; do NOT seed defaults
    await this.loadProfilesFromDirectory(dir);
  }

  private async ensureDefaultProfiles(globalAgentsDir: string): Promise<void> {
    try {
      await fs.mkdir(globalAgentsDir, { recursive: true });
    } catch (err) {
      logger.error(`Failed to create global agents directory ${globalAgentsDir}: ${err}`);
      return;
    }

    // Only create default profiles if the directory is empty
    const isDirectoryEmpty = await this.isAgentsDirectoryEmpty(globalAgentsDir);
    if (!isDirectoryEmpty) {
      logger.debug('Agents directory is not empty, skipping default profile creation');
      return;
    }

    for (const defaultProfile of DEFAULT_AGENT_PROFILES) {
      if (this.profiles.has(defaultProfile.id)) {
        continue;
      }

      const dirName = deriveDirName(defaultProfile.name, new Set());
      const profileDir = path.join(globalAgentsDir, dirName);
      const configPath = path.join(profileDir, 'config.json');

      try {
        await fs.access(configPath);
      } catch {
        // Config file doesn't exist, create it
        await fs.mkdir(profileDir, { recursive: true });
        await this.saveProfileToFile(defaultProfile, configPath);
        logger.debug(`Created default agent profile: ${defaultProfile.id} in directory: ${dirName}`);
      }
    }

    await this.saveOrderFile(globalAgentsDir, new Map(DEFAULT_AGENT_PROFILES.map((p, index) => [p.id, index])));
  }

  private async setupGlobalFileWatcher(): Promise<void> {
    // Clean up existing global watcher
    const globalAgentsDir = getGlobalAgentsDir();
    const existingWatcher = this.directoryWatchers.get(globalAgentsDir);
    if (existingWatcher) {
      await existingWatcher.close();
    }
    const existingRulesWatcher = this.directoryWatchers.get(`${globalAgentsDir}-rules`);
    if (existingRulesWatcher) {
      await existingRulesWatcher.close();
    }

    // Watch global agents directory
    await this.setupWatcherForDirectory(globalAgentsDir);
  }

  private async setupWatcherForDirectory(agentsDir: string): Promise<void> {
    // Create directory if it doesn't exist
    const dirExists = await fs
      .access(agentsDir)
      .then(() => true)
      .catch(() => false);
    if (!dirExists) {
      try {
        await fs.mkdir(agentsDir, { recursive: true });
      } catch (err) {
        logger.error(`Failed to create agents directory ${agentsDir}: ${err}`);
        return;
      }
    }

    // Close existing watcher for this directory if any
    const existingWatcher = this.directoryWatchers.get(agentsDir);
    if (existingWatcher) {
      await existingWatcher.close();
    }
    const existingRulesWatcher = this.directoryWatchers.get(`${agentsDir}-rules`);
    if (existingRulesWatcher) {
      await existingRulesWatcher.close();
    }

    const watcher = watch(agentsDir, {
      persistent: true,
      usePolling: shouldUsePolling(agentsDir, this.store.getSettings().fileWatchMode),
      ignoreInitial: true,
    });

    // Also watch rules subdirectories within each agent directory
    const rulesWatcher = watch(path.join(agentsDir, '*', AIDER_DESK_RULES_DIR), {
      persistent: true,
      usePolling: shouldUsePolling(agentsDir, this.store.getSettings().fileWatchMode),
      ignoreInitial: true,
    });

    const reloadFunction = () => this.debounceReloadProfiles(agentsDir);

    watcher
      .on('add', async () => {
        await reloadFunction();
      })
      .on('change', async () => {
        await reloadFunction();
      })
      .on('unlink', async () => {
        await reloadFunction();
      })
      .on('error', (error) => {
        logger.error(`Watcher error for ${agentsDir}: ${error}`);
      });

    // Set up rules watcher event handlers
    rulesWatcher
      .on('add', async () => {
        await reloadFunction();
      })
      .on('change', async () => {
        await reloadFunction();
      })
      .on('unlink', async () => {
        await reloadFunction();
      })
      .on('error', (error) => {
        logger.error(`Rules watcher error for ${agentsDir}: ${error}`);
      });

    this.directoryWatchers.set(agentsDir, watcher);
    this.directoryWatchers.set(`${agentsDir}-rules`, rulesWatcher);
  }

  private debounceReloadProfiles = debounce(async (agentsDir: string) => {
    await this.reloadProfiles(agentsDir);
  }, 1000);

  private async reloadProfiles(agentsDir: string): Promise<void> {
    logger.debug(`Reloading agent profiles from ${agentsDir}`);

    // Snapshot existing profile IDs for this directory
    const existingProfilesInDir: Map<string, AgentProfileContext> = new Map();
    for (const [profileId, context] of this.profiles.entries()) {
      if (getAgentsDirForProfile(context.agentProfile) === agentsDir) {
        existingProfilesInDir.set(profileId, context);
      }
    }

    // Load profiles from directory (overwrites existing entries on success)
    await this.loadProfilesFromDirectory(agentsDir);

    // Remove profiles that are no longer present AND whose directory is gone.
    // Keeps profiles that failed to load due to transient errors (e.g. SSHFS lag).
    for (const [profileId, context] of existingProfilesInDir) {
      const profileDir = path.join(agentsDir, context.dirName);
      const dirExists = await fs
        .access(profileDir)
        .then(() => true)
        .catch(() => false);
      if (!dirExists) {
        this.profiles.delete(profileId);
      }
    }

    this.sendAgentProfilesUpdated();
  }

  private async getExistingDirNames(agentsDir: string): Promise<Set<string>> {
    const dirNames = new Set<string>();

    try {
      const entries = await fs.readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          dirNames.add(entry.name);
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return dirNames;
  }

  private async isAgentsDirectoryEmpty(agentsDir: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(agentsDir, { withFileTypes: true });

      // Check if there are any directories (profiles)
      for (const entry of entries) {
        if (entry.isDirectory()) {
          return false; // Found at least one profile directory
        }
      }

      return true; // No profile directories found
    } catch {
      // Directory doesn't exist or can't be read, treat as empty
      return true;
    }
  }

  private async loadProfilesFromDirectory(agentsDir: string): Promise<void> {
    const dirExists = await fs
      .access(agentsDir)
      .then(() => true)
      .catch(() => false);
    if (!dirExists) {
      logger.debug(`Agents directory does not exist, skipping: ${agentsDir}`);
      return;
    }

    logger.debug(`Loading agent profiles from ${agentsDir}`);

    // Load order first
    const order = await this.loadOrderFile(agentsDir);
    const profilesMap = new Map<string, AgentProfileContext>();

    try {
      const entries = await fs.readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = path.join(agentsDir, entry.name, 'config.json');
          const profile = await this.loadProfileFile(configPath, entry.name);

          if (profile) {
            // Force the tier from the directory (authoritative, independent of file contents)
            profile.workflowAgent = agentsDir === getWorkflowAgentsDir();
            const profileContext: AgentProfileContext = {
              dirName: entry.name,
              order: 0, // Will be set by order file
              agentProfile: profile,
            };
            profilesMap.set(profile.id, profileContext);
          } else {
            // If no config.json exists, check if this is a project-level directory
            // and if there's a corresponding global profile, merge project-level rule files
            if (agentsDir.includes('.aider-desk/agents')) {
              await this.mergeProjectRuleFilesIntoGlobalProfile(entry.name, agentsDir);
            }
          }
        }
      }

      // Apply order to profiles
      const orderedProfiles = this.applyOrderToProfiles(profilesMap, order);

      // If no order file exists, create one based on current order
      if (order.size === 0 && profilesMap.size > 0) {
        await this.createDefaultOrderFromProfiles(orderedProfiles, agentsDir);
      }

      // Add profiles to the main profiles map
      for (const [profileId, context] of orderedProfiles.entries()) {
        this.profiles.set(profileId, context);
      }
    } catch (err) {
      logger.error(`Failed to read agents directory ${agentsDir}: ${err}`);
    }
  }

  private sanitizeAgentProfile(loadedProfile: AgentProfile, agentDirName: string): AgentProfile {
    return {
      ...loadedProfile,
      id: loadedProfile.id || uuidv4(),
      name: loadedProfile.name || agentDirName,
      provider: loadedProfile.provider || DEFAULT_AGENT_PROFILE.provider,
      model: loadedProfile.model || DEFAULT_AGENT_PROFILE.model,
      maxIterations: loadedProfile.maxIterations ?? DEFAULT_AGENT_PROFILE.maxIterations,
      minTimeBetweenToolCalls: loadedProfile.minTimeBetweenToolCalls ?? DEFAULT_AGENT_PROFILE.minTimeBetweenToolCalls,
      enabledServers: loadedProfile.enabledServers ?? [],
      disabledExtensionTools: loadedProfile.disabledExtensionTools ?? [],
      customInstructions: loadedProfile.customInstructions ?? '',
      toolApprovals: {
        ...loadedProfile.toolApprovals,
      },
      toolSettings: {
        ...loadedProfile.toolSettings,
      },
      subagent: {
        ...DEFAULT_AGENT_PROFILE.subagent,
        ...loadedProfile.subagent,
      },
    };
  }

  private async loadProfileFile(filePath: string, dirName: string): Promise<AgentProfile | null> {
    try {
      if (!(await fileExists(filePath))) {
        return null;
      }

      logger.debug(`Loading agent profile from ${filePath}`);

      const content = await fs.readFile(filePath, 'utf-8');
      const loadedProfile: AgentProfile = JSON.parse(content);

      // Sanitize profile with defaults.
      // Loading a profile must never write back to disk.
      const profile = this.sanitizeAgentProfile(loadedProfile, dirName);

      // Discover and load rule files for this profile
      profile.ruleFiles = await getAllRuleFilesForProfile(profile, dirName);

      logger.info(`Loaded agent profile: ${profile.name} with ${profile.ruleFiles.length} rule files`);
      return profile;
    } catch (err) {
      logger.error(`Failed to parse agent profile file ${filePath}: ${err}`);
      return null;
    }
  }

  private async saveProfileToFile(profile: AgentProfile, filePath: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // Create a copy of the profile without ruleFiles since they are dynamically discovered
      const { ruleFiles: _ruleFiles, ...profileToSave } = profile;
      await fs.writeFile(filePath, JSON.stringify(profileToSave, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to save agent profile to ${filePath}: ${err}`);
      throw err;
    }
  }

  private async loadOrderFile(agentsDir: string): Promise<Map<string, number>> {
    const orderPath = path.join(agentsDir, 'order.json');
    const order = new Map<string, number>();

    try {
      await fs.access(orderPath);
      const content = await fs.readFile(orderPath, 'utf-8');
      const orderData = JSON.parse(content);

      for (const [profileId, orderIndex] of Object.entries(orderData)) {
        if (typeof orderIndex === 'number') {
          order.set(profileId, orderIndex);
        }
      }

      logger.debug(`Loaded order for ${order.size} profiles from ${orderPath}`);
    } catch {
      logger.debug(`No order file found at ${orderPath}, will create default order`);
    }

    return order;
  }

  private async saveOrderFile(agentsDir: string, order: Map<string, number>): Promise<void> {
    const orderPath = path.join(agentsDir, 'order.json');
    const orderData: Record<string, number> = {};

    for (const [profileId, orderIndex] of Array.from(order.entries())) {
      orderData[profileId] = orderIndex;
    }

    try {
      await fs.mkdir(path.dirname(orderPath), { recursive: true });
      await fs.writeFile(orderPath, JSON.stringify(orderData, null, 2), 'utf-8');
      logger.debug(`Saved order for ${order.size} profiles to ${orderPath}`);
    } catch (err) {
      logger.error(`Failed to save order file to ${orderPath}: ${err}`);
      throw err;
    }
  }

  private applyOrderToProfiles(profilesMap: Map<string, AgentProfileContext>, order: Map<string, number>): Map<string, AgentProfileContext> {
    const sortedEntries = Array.from(profilesMap.entries()).sort(([, a], [, b]) => {
      const orderA = order.get(a.agentProfile.id);
      const orderB = order.get(b.agentProfile.id);

      // If both have order, use it
      if (orderA !== undefined && orderB !== undefined) {
        return orderA - orderB;
      }

      // If only one has order, the one with order comes first
      if (orderA !== undefined) {
        return -1;
      }
      if (orderB !== undefined) {
        return 1;
      }

      // If neither has order, maintain original order (by name as fallback)
      return a.agentProfile.name.localeCompare(b.agentProfile.name);
    });

    return new Map(sortedEntries);
  }

  private async createDefaultOrderFromProfiles(profilesMap: Map<string, AgentProfileContext>, agentsDir: string): Promise<void> {
    const order = new Map<string, number>();
    let index = 0;
    for (const [profileId, context] of profilesMap.entries()) {
      order.set(profileId, index);
      context.order = index;
      index++;
    }
    await this.saveOrderFile(agentsDir, order);
  }

  public async createProfile(profile: AgentProfile, projectDir?: string): Promise<void> {
    if (!profile.id) {
      throw new Error('Agent profile must have an id');
    }

    const agentsDir = profile.workflowAgent
      ? getWorkflowAgentsDir()
      : projectDir
        ? getProjectAgentsDir(projectDir)
        : getGlobalAgentsDir();
    if (profile.workflowAgent) {
      profile.projectDir = undefined; // workflow agents are tier-scoped, never project-scoped
    }

    // Get existing directory names for collision handling
    const existingDirNames = await this.getExistingDirNames(agentsDir);

    // Derive unique directory name
    const dirName = deriveDirName(profile.name, existingDirNames);

    // Create directory and save config.json
    const profileDir = path.join(agentsDir, dirName);
    const configPath = path.join(profileDir, 'config.json');

    await fs.mkdir(profileDir, { recursive: true });

    // Create markdown sidecar files (empty or with default content)
    await fs.writeFile(path.join(profileDir, 'customInstructions.md'), profile.customInstructions || '', 'utf-8');
    await fs.writeFile(path.join(profileDir, 'systemPrompt.md'), profile.systemPrompt || '', 'utf-8');
    await fs.writeFile(path.join(profileDir, 'subagent.systemPrompt.md'), profile.subagent?.systemPrompt || '', 'utf-8');
    await fs.writeFile(path.join(profileDir, 'subagent.description.md'), profile.subagent?.description || '', 'utf-8');

    await this.saveProfileToFile(profile, configPath);

    // Reload profiles to update the cache
    await this.reloadProfiles(agentsDir);
  }

  public async updateProfile(profile: AgentProfile): Promise<void> {
    if (!profile.id) {
      throw new Error('Agent profile must have an id');
    }

    const existingContext = this.profiles.get(profile.id);

    if (!existingContext) {
      throw new Error(`Agent profile with id ${profile.id} not found`);
    }

    const agentsDir = getAgentsDirForProfile(existingContext.agentProfile);
    const configPath = path.join(agentsDir, existingContext.dirName, 'config.json');

    existingContext.agentProfile = profile;
    await this.saveProfileToFile(profile, configPath);

    this.sendAgentProfilesUpdated();
  }

  public async deleteProfile(profileId: string): Promise<void> {
    const existingContext = this.profiles.get(profileId);

    if (!existingContext) {
      throw new Error(`Agent profile with id ${profileId} not found`);
    }

    const agentsDir = getAgentsDirForProfile(existingContext.agentProfile);
    const profileDir = path.join(agentsDir, existingContext.dirName);

    try {
      await fs.rm(profileDir, { recursive: true, force: true });
      this.profiles.delete(profileId);
    } catch (err) {
      logger.error(`Failed to delete agent profile directory ${profileDir}: ${err}`);
      throw err;
    }

    // Reload profiles to update the cache
    await this.debounceReloadProfiles(agentsDir);
  }

  public getProfile(profileId: string): AgentProfile | undefined {
    // Check extension agents first (they can override file-based profiles)
    const extensionAgent = this.extensionManager.getAgentById(profileId);
    if (extensionAgent) {
      return extensionAgent.agent;
    }
    // Fall back to file-based profiles
    return this.profiles.get(profileId)?.agentProfile;
  }

  public resolveAgentProfile(id: string): AgentProfile | null {
    const lowerId = id.toLowerCase();

    // 1. Try matching by profile id (covers both file-based and extension agents)
    const directMatch = this.getProfile(id);
    if (directMatch) {
      return directMatch;
    }

    const allProfiles = this.getAllProfiles();

    // 2. Try matching by profile name (case-insensitive)
    for (const profile of allProfiles) {
      if (profile.name.toLowerCase() === lowerId) {
        return profile;
      }
    }

    // 3. Try matching by dirName (folder name) for file-based profiles
    for (const context of this.profiles.values()) {
      if (context.dirName.toLowerCase() === lowerId) {
        return context.agentProfile;
      }
    }

    // 4. Try matching by dirName using slugified input
    const slugifiedId = deriveDirName(id, new Set()).toLowerCase();
    for (const context of this.profiles.values()) {
      if (context.dirName.toLowerCase() === slugifiedId) {
        return context.agentProfile;
      }
    }

    // 5. Try matching by derived name from profile name (slugified + filenamified)
    for (const profile of allProfiles) {
      const derivedName = deriveDirName(profile.name, new Set()).toLowerCase();
      if (derivedName === slugifiedId) {
        return profile;
      }
    }

    return null;
  }

  private getOrderedProfiles(profileContexts: AgentProfileContext[]): AgentProfile[] {
    return profileContexts
      .sort((a, b) => {
        // First, prioritize project profiles over global profiles
        const aIsProject = !!a.agentProfile.projectDir;
        const bIsProject = !!b.agentProfile.projectDir;

        if (aIsProject && !bIsProject) {
          return -1;
        }
        if (!aIsProject && bIsProject) {
          return 1;
        }

        // Then sort by order within the same scope
        return a.order - b.order;
      })
      .map((ctx) => ctx.agentProfile);
  }

  private getGlobalProfiles(): AgentProfile[] {
    return this.getOrderedProfiles(Array.from(this.profiles.values()).filter((ctx) => !ctx.agentProfile.projectDir && !ctx.agentProfile.workflowAgent));
  }

  public getAllProfiles(): AgentProfile[] {
    // Get extension agents first (they can override file-based profiles)
    const extensionAgents = this.extensionManager.getAgents(undefined).map((registered) => registered.agent);
    // Then get file-based profiles
    const fileBasedProfiles = this.getOrderedProfiles(Array.from(this.profiles.values()));
    // Extension agents come first for override capability
    return [...extensionAgents, ...fileBasedProfiles.filter((profile) => !extensionAgents.some((extAgent) => extAgent.id === profile.id))];
  }

  public getProjectProfiles(project: Project, includeGlobal = true, includeExtension = true): AgentProfile[] {
    const projectProfiles = Array.from(this.profiles.values()).filter((ctx) => ctx.agentProfile.projectDir === project.baseDir);
    const profiles = this.getOrderedProfiles(projectProfiles);

    if (includeGlobal) {
      profiles.push(...this.getGlobalProfiles());
    }

    if (includeExtension) {
      const extensionAgents = this.extensionManager.getAgents(project).map((registered) => registered.agent);
      // Extension agents come first for override capability
      return [...extensionAgents, ...profiles.filter((profile) => !extensionAgents.some((extAgent) => extAgent.id === profile.id))];
    }

    return profiles;
  }

  public getWorkflowAgentProfiles(): AgentProfile[] {
    return this.getOrderedProfiles(
      Array.from(this.profiles.values()).filter((ctx) => ctx.agentProfile.workflowAgent === true),
    );
  }

  public async updateAgentProfilesOrder(agentProfiles: AgentProfile[]): Promise<void> {
    // Group profiles by their resolved agents directory (global/project/workflow tiers)
    const profilesByDir = new Map<string, AgentProfile[]>();
    for (const p of agentProfiles) {
      const dir = getAgentsDirForProfile(p);
      (profilesByDir.get(dir) ?? profilesByDir.set(dir, []).get(dir)!).push(p);
    }

    // Process each group separately
    for (const [agentsDir, profiles] of profilesByDir.entries()) {
      // Create order map for this group
      const order = new Map(profiles.map((p, i) => [p.id, i]));

      // Save the order file for this group
      await this.saveOrderFile(agentsDir, order);

      // Update the in-memory profiles for this group
      for (const [profileId, ctx] of this.profiles.entries()) {
        if (getAgentsDirForProfile(ctx.agentProfile) === agentsDir) {
          const newOrder = order.get(profileId);
          if (newOrder !== undefined) ctx.order = newOrder;
        }
      }
    }

    // Notify listeners
    this.sendAgentProfilesUpdated();
  }

  private async mergeProjectRuleFilesIntoGlobalProfile(agentDirName: string, projectAgentsDir: string): Promise<void> {
    // Check if there are project-level rule files
    const projectRuleFiles = await getRuleFilesForAgent(agentDirName, projectAgentsDir);

    if (projectRuleFiles.length === 0) {
      return; // No project-level rule files to merge
    }

    // Find the corresponding global profile by directory name
    let globalProfileEntry: [string, AgentProfileContext] | null = null;
    for (const [profileId, context] of this.profiles.entries()) {
      if (context.dirName === agentDirName && !context.agentProfile.projectDir) {
        globalProfileEntry = [profileId, context];
        break;
      }
    }

    if (!globalProfileEntry) {
      return; // No global profile found with matching directory name
    }

    const [profileId, globalProfileContext] = globalProfileEntry;

    // Create a new profile object with merged rule files
    const updatedProfile = {
      ...globalProfileContext.agentProfile,
      ruleFiles: [...(globalProfileContext.agentProfile.ruleFiles || []), ...projectRuleFiles],
    };

    // Update the profile context
    const updatedContext: AgentProfileContext = {
      ...globalProfileContext,
      agentProfile: updatedProfile,
    };

    this.profiles.set(profileId, updatedContext);
    logger.debug(`Merged ${projectRuleFiles.length} project-level rule files into global profile: ${agentDirName}`);
  }

  // ── Markdown ↔ Config sync methods ──

  private readonly MD_SIDECAR_FILES = [
    'customInstructions.md',
    'systemPrompt.md',
    'subagent.systemPrompt.md',
    'subagent.description.md',
  ] as const;

  public async syncMdToConfig(profileId: string): Promise<AgentProfile | null> {
    const context = this.profiles.get(profileId);
    if (!context) {
      throw new Error(`Agent profile with id ${profileId} not found`);
    }

    const agentsDir = getAgentsDirForProfile(context.agentProfile);
    const agentDir = path.join(agentsDir, context.dirName);
    const configPath = path.join(agentDir, 'config.json');

    // Read current config and create a mutable copy
    const profile: AgentProfile = JSON.parse(JSON.stringify(context.agentProfile));

    // Read and overlay each markdown file
    for (const filename of this.MD_SIDECAR_FILES) {
      const mdPath = path.join(agentDir, filename);
      if (await fileExists(mdPath)) {
        const content = await fs.readFile(mdPath, 'utf-8');
        if (filename === 'customInstructions.md') {
          profile.customInstructions = content;
        } else if (filename === 'systemPrompt.md') {
          profile.systemPrompt = content;
        } else if (filename === 'subagent.systemPrompt.md') {
          profile.subagent = { ...profile.subagent, systemPrompt: content };
        } else if (filename === 'subagent.description.md') {
          profile.subagent = { ...profile.subagent, description: content };
        }
      }
    }

    // Save updated config
    await this.saveProfileToFile(profile, configPath);

    // Update in-memory
    context.agentProfile = profile;
    this.sendAgentProfilesUpdated();

    return profile;
  }

  public async syncConfigToMd(profileId: string): Promise<void> {
    const context = this.profiles.get(profileId);
    if (!context) {
      throw new Error(`Agent profile with id ${profileId} not found`);
    }

    const agentsDir = getAgentsDirForProfile(context.agentProfile);
    const agentDir = path.join(agentsDir, context.dirName);
    const profile = context.agentProfile;

    // Write each markdown file from config
    await fs.writeFile(path.join(agentDir, 'customInstructions.md'), profile.customInstructions || '', 'utf-8');
    await fs.writeFile(path.join(agentDir, 'systemPrompt.md'), profile.systemPrompt || '', 'utf-8');
    await fs.writeFile(path.join(agentDir, 'subagent.systemPrompt.md'), profile.subagent?.systemPrompt || '', 'utf-8');
    await fs.writeFile(path.join(agentDir, 'subagent.description.md'), profile.subagent?.description || '', 'utf-8');
  }

  public async autoSyncProfile(profileId: string): Promise<{ direction: 'md-to-config' | 'config-to-md' | 'in-sync'; files: string[] }> {
    const context = this.profiles.get(profileId);
    if (!context) {
      throw new Error(`Agent profile with id ${profileId} not found`);
    }

    const agentsDir = getAgentsDirForProfile(context.agentProfile);
    const agentDir = path.join(agentsDir, context.dirName);
    const configPath = path.join(agentDir, 'config.json');

    // Get config.json mtime
    const configStat = await fs.stat(configPath);
    const configMtime = configStat.mtimeMs;

    const newerMdFiles: string[] = [];
    const olderMdFiles: string[] = [];

    for (const filename of this.MD_SIDECAR_FILES) {
      const mdPath = path.join(agentDir, filename);
      if (await fileExists(mdPath)) {
        const mdStat = await fs.stat(mdPath);
        if (mdStat.mtimeMs > configMtime) {
          newerMdFiles.push(filename);
        } else if (mdStat.mtimeMs < configMtime) {
          olderMdFiles.push(filename);
        }
      }
    }

    if (newerMdFiles.length > 0) {
      await this.syncMdToConfig(profileId);
      return { direction: 'md-to-config', files: newerMdFiles };
    } else if (olderMdFiles.length > 0) {
      await this.syncConfigToMd(profileId);
      return { direction: 'config-to-md', files: olderMdFiles };
    }

    return { direction: 'in-sync', files: [] };
  }

  public async autoSyncAllProfiles(): Promise<Array<{ profileId: string; profileName: string; result: { direction: string; files: string[] } | null }>> {
    const results: Array<{ profileId: string; profileName: string; result: { direction: string; files: string[] } | null }> = [];

    for (const [profileId, context] of this.profiles.entries()) {
      try {
        const result = await this.autoSyncProfile(profileId);
        results.push({ profileId, profileName: context.agentProfile.name, result });
      } catch (err) {
        logger.error(`Failed to auto-sync profile ${profileId}: ${err}`);
        results.push({ profileId, profileName: context.agentProfile.name, result: null });
      }
    }

    return results;
  }

  public async getSyncStatus(profileId: string): Promise<{ mdNewer: string[]; configNewer: string[]; inSync: boolean }> {
    const context = this.profiles.get(profileId);
    if (!context) {
      throw new Error(`Agent profile with id ${profileId} not found`);
    }

    const agentsDir = getAgentsDirForProfile(context.agentProfile);
    const agentDir = path.join(agentsDir, context.dirName);
    const configPath = path.join(agentDir, 'config.json');

    const configStat = await fs.stat(configPath);
    const configMtime = configStat.mtimeMs;

    const mdNewer: string[] = [];
    const configNewer: string[] = [];

    for (const filename of this.MD_SIDECAR_FILES) {
      const mdPath = path.join(agentDir, filename);
      if (await fileExists(mdPath)) {
        const mdStat = await fs.stat(mdPath);
        if (mdStat.mtimeMs > configMtime) {
          mdNewer.push(filename);
        } else if (mdStat.mtimeMs < configMtime) {
          configNewer.push(filename);
        }
      }
    }

    return { mdNewer, configNewer, inSync: mdNewer.length === 0 && configNewer.length === 0 };
  }

  async dispose(): Promise<void> {
    // Remove extension change listener
    this.extensionManager.removeListener(this.extensionsChangeListener);

    // Clean up all directory watchers
    for (const watcher of this.directoryWatchers.values()) {
      await watcher.close();
    }
    this.directoryWatchers.clear();

    // Clear profiles
    this.profiles.clear();
  }

  async settingsChanged(oldSettings: SettingsData, newSettings: SettingsData): Promise<void> {
    if (oldSettings.fileWatchMode === newSettings.fileWatchMode) {
      return;
    }

    const watchedDirs = Array.from(this.directoryWatchers.keys());
    for (const watcher of this.directoryWatchers.values()) {
      await watcher.close();
    }
    this.directoryWatchers.clear();

    for (const dir of watchedDirs) {
      if (dir.endsWith('-rules')) {
        continue;
      }
      await this.setupWatcherForDirectory(dir);
    }
  }

  getDefaultAgentProfileId() {
    for (const defaultProfile of DEFAULT_AGENT_PROFILES) {
      if (this.profiles.has(defaultProfile.id)) {
        return defaultProfile.id;
      }
    }

    return (
      this.profiles.values().find((c) => !c.agentProfile.workflowAgent)?.agentProfile.id
      || DEFAULT_AGENT_PROFILE.id
    );
  }
}
