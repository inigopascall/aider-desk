import path from 'path';
import fs from 'fs/promises';

import { v4 as uuidv4 } from 'uuid';
import { createMCPClient, UnauthorizedError as AiSdkUnauthorizedError, type CallToolResult, type ListToolsResult, type MCPClient } from '@ai-sdk/mcp';
import { type JSONValue } from '@ai-sdk/provider';
import { UnauthorizedError as McpSdkUnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Tool, type ToolExecutionOptions, type ToolSet } from 'ai';
import {
  AgentProfile,
  McpOAuthStatus,
  McpServerConfig,
  McpTool,
  McpToolInputSchema,
  PromptContext,
  ToolApprovalState,
  type McpOAuthStatusData,
} from '@common/types';
import { LlmProviderName } from '@common/agent';
import { delay } from '@common/utils';
import { TOOL_GROUP_NAME_SEPARATOR } from '@common/tools';

import { ApprovalManager } from './tools/approval-manager';
import { McpOAuthManager } from './mcp-oauth-manager';
import { truncateToolResult } from './utils';

import logger from '@/logger';
import { AIDER_DESK_CACHE_DIR } from '@/constants';
import { translate } from '@/utils/i18n';
import { Task } from '@/task';

const MCP_TOOLS_CACHE_FILE = path.join(AIDER_DESK_CACHE_DIR, 'mcp-tools-cache.json');
const MCP_TOOLS_CACHE_VERSION = 1;

export interface McpToolsCacheEntry {
  tools: McpTool[];
  cachedAt: number;
}

export interface McpToolsCache {
  version: number;
  servers: Record<string, McpToolsCacheEntry>;
}

const MCP_CLIENT_TIMEOUT = 600_000;
const MCP_INIT_TIMEOUT = 60_000;
const MCP_QUARANTINE_BASE_MS = 30_000;
const MCP_QUARANTINE_MAX_MS = 10 * 60_000;

export class McpAuthenticationRequiredError extends Error {
  constructor(serverName: string, language?: string) {
    super(translate(language, 'mcp.oauth.authenticationRequiredMessage', { serverName }));
    this.name = 'McpAuthenticationRequiredError';
  }
}

interface McpConnector {
  client: MCPClient;
  serverName: string;
  poolKey: string;
  tools: McpTool[];
  toolDefinitions: ListToolsResult;
  serverConfig: McpServerConfig;
  projectDir: string | null;
  taskDir: string | null;
}

export interface McpServerFailure {
  serverName: string;
  scope: string;
  message: string;
  failedAt: number;
  attempts: number;
  nextRetryAt: number;
}

type McpClientTransport = Parameters<typeof createMCPClient>[0]['transport'];
type McpToolDefinition = ListToolsResult['tools'][number];

export class McpManager {
  private mcpConnectors: Map<string, Promise<McpConnector>> = new Map();
  private connectorServerUrls: Map<string, string> = new Map();
  private connectorConfigs: Map<string, string> = new Map();
  private quarantine: Map<string, McpServerFailure> = new Map();
  private currentInitId: string | null = null;
  private toolsCache: McpToolsCache = { version: MCP_TOOLS_CACHE_VERSION, servers: {} };

  constructor(
    private readonly oauthManager = new McpOAuthManager(),
    private readonly getLanguage: () => string = () => 'en',
  ) {}

  async init() {
    await Promise.all([this.loadToolsCache(), this.oauthManager.init()]);
  }

  async createToolset(
    task: Task,
    profile: AgentProfile,
    providerName: LlmProviderName,
    mcpServers: Record<string, McpServerConfig>,
    approvalManager: ApprovalManager,
    promptContext?: PromptContext,
  ): Promise<ToolSet> {
    let connectors: McpConnector[] = [];
    try {
      const initStartTime = Date.now();
      let loadingMessageShown = false;

      const loadingTimeout =
        promptContext &&
        setTimeout(() => {
          loadingMessageShown = true;
          task.addLogMessage('loading', 'Initializing MCP servers...', false, promptContext);
        }, 3000);

      try {
        const { connectors: initializedConnectors, failures } = await this.initMcpConnectors(
          mcpServers,
          task.getProjectDir(),
          task.getTaskDir(),
          false,
          profile.enabledServers,
        );
        connectors = initializedConnectors;
        for (const failure of failures) {
          task.addLogMessage(
            'warning',
            `MCP server '${failure.serverName}' is unavailable and will be retried after ${new Date(failure.nextRetryAt).toLocaleTimeString()}: ${failure.message}`,
            false,
            promptContext,
          );
        }
      } finally {
        clearTimeout(loadingTimeout);
        if (loadingMessageShown) {
          task.addLogMessage('loading', undefined, false, promptContext);
        }
      }

      for (const serverName of profile.enabledServers) {
        const config = mcpServers[serverName];
        if (!config?.url) {
          continue;
        }
        const oauthStatus = await this.oauthManager.getStatus(config.url);
        if (oauthStatus.status === McpOAuthStatus.AuthenticationRequired || oauthStatus.status === McpOAuthStatus.Authorizing) {
          task.addLogMessage('error', translate(this.getLanguage(), 'mcp.oauth.authenticationRequiredMessage', { serverName }), false, promptContext);
        }
      }

      const initTime = Date.now() - initStartTime;
      logger.debug(`MCP servers initialized in ${initTime}ms`);
    } catch (error) {
      logger.error('Error initializing MCP clients:', error);
      task.addLogMessage('error', `Error initializing MCP clients: ${error}`, false, promptContext);
    }

    const toolSet: ToolSet = {};
    const lastToolCallTimeRef = { value: 0 };

    for (const mcpConnector of connectors) {
      if (!profile.enabledServers.includes(mcpConnector.serverName)) {
        continue;
      }

      const toolDefinitions = {
        ...mcpConnector.toolDefinitions,
        tools: mcpConnector.toolDefinitions.tools.map((toolDefinition) => ({
          ...toolDefinition,
          inputSchema: this.fixInputSchema(providerName, this.normalizeToolInputSchema(toolDefinition.inputSchema)),
        })),
      } satisfies ListToolsResult;
      const mcpTools = mcpConnector.client.toolsFromDefinitions(toolDefinitions);

      for (const toolDefinition of toolDefinitions.tools) {
        const toolId = `${mcpConnector.serverName}${TOOL_GROUP_NAME_SEPARATOR}${toolDefinition.name}`;
        const normalizedToolId = toolId.toLowerCase().replaceAll(/\s+/g, '_');

        const approvalState = profile.toolApprovals[toolId];
        if (approvalState === ToolApprovalState.Never) {
          logger.debug(`Skipping tool due to 'Never' approval state: ${toolId}`);
          continue;
        }

        const mcpTool = mcpTools[toolDefinition.name];
        if (!mcpTool) {
          logger.warn(`AI SDK did not create MCP tool: ${toolId}`);
          continue;
        }

        toolSet[normalizedToolId] = this.wrapMcpTool(mcpConnector, toolDefinition, task, profile, mcpTool, approvalManager, lastToolCallTimeRef, promptContext);
      }
    }

    return toolSet;
  }

  private wrapMcpTool(
    connector: McpConnector,
    toolDefinition: McpToolDefinition,
    task: Task,
    profile: AgentProfile,
    toolDef: Tool,
    approvalManager: ApprovalManager,
    lastToolCallTimeRef: { value: number },
    promptContext?: PromptContext,
  ): Tool {
    const toolName = toolDefinition.name;
    const serverName = connector.serverName;
    const toolId = `${serverName}${TOOL_GROUP_NAME_SEPARATOR}${toolName}`;
    const originalExecute = toolDef.execute;
    if (!originalExecute) {
      throw new Error(`AI SDK MCP tool ${toolId} does not have an execute function`);
    }

    const execute = async (args: unknown, options: ToolExecutionOptions<unknown>) => {
      const input = args as Record<string, unknown> | undefined;
      task.addToolMessage(options.toolCallId, serverName, toolName, input, undefined, undefined, promptContext);

      const questionText = `Approve tool ${toolName} from ${serverName} MCP server?`;
      const questionSubject = input ? JSON.stringify(input) : undefined;
      const [isApproved, userInput] = await approvalManager.handleToolApproval(toolId, input, toolId, questionText, questionSubject);

      if (!isApproved) {
        logger.warn(`Tool execution denied by user: ${toolId}`);
        return this.createMcpErrorResult(`Tool execution denied by user.${userInput ? ` User input: ${userInput}` : ''}`);
      }
      logger.debug(`Tool execution approved: ${toolId}`);

      const timeSinceLastCall = Date.now() - lastToolCallTimeRef.value;
      const currentMinTime = profile.minTimeBetweenToolCalls;
      const remainingDelay = currentMinTime - timeSinceLastCall;

      if (remainingDelay > 0) {
        logger.debug(`Delaying tool call by ${remainingDelay}ms to respect minTimeBetweenToolCalls (${currentMinTime}ms)`);
        await delay(remainingDelay);
      }

      try {
        const timeoutSignal = AbortSignal.timeout(MCP_CLIENT_TIMEOUT);
        const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeoutSignal]) : timeoutSignal;
        const callTool = (target: McpConnector) => {
          const targetExecute = target === connector ? originalExecute : this.getToolExecute(target, toolDefinition);
          return targetExecute(args, { ...options, abortSignal });
        };

        // Resolve the pooled connector at call time: a reload or reconnect may have
        // replaced the connector this toolset was built with.
        let target = await this.resolveLiveConnector(connector);
        let response;
        try {
          response = await callTool(target);
        } catch (error) {
          if (abortSignal.aborted || !this.isClosedClientError(error)) {
            throw error;
          }
          // The request never left this process, so reconnecting and retrying once is safe.
          logger.warn(`MCP client for server ${serverName} is closed; reconnecting and retrying tool '${toolName}' once`);
          target = await this.reconnectConnector(target);
          response = await callTool(target);
        }

        logger.debug(`Tool ${toolName} returned response`, this.describeToolResponse(response));

        if (response && typeof response === 'object' && 'content' in response && Array.isArray(response.content)) {
          for (const part of response.content) {
            if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
              part.text = await truncateToolResult(part.text);
            }
          }
        }

        lastToolCallTimeRef.value = Date.now();
        return response;
      } catch (error) {
        lastToolCallTimeRef.value = Date.now();
        if (options.abortSignal?.aborted) {
          throw error;
        }

        logger.error(`Error calling tool ${toolId}:`, error);
        if (this.isConnectionClosedError(error)) {
          this.evictConnector(connector, `tool call '${toolName}' failed: ${error instanceof Error ? error.message : String(error)}`);
          // Quarantine the exact pool key once so immediate subsequent prompts do
          // not reconnect-loop; retry happens after the backoff or a manual reload.
          this.quarantineConnector(connector.poolKey, connector.serverName, error);
        }
        return this.createMcpErrorResult(`Error executing tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const originalToModelOutput = toolDef.toModelOutput;
    const toModelOutput: Tool['toModelOutput'] = originalToModelOutput
      ? (options) => {
          if (this.isMcpCallToolResult(options.output)) {
            return originalToModelOutput(options);
          }
          return { type: 'json', value: options.output as JSONValue };
        }
      : undefined;

    logger.debug(`Wrapping AI SDK MCP tool: ${toolName}`, toolDef);
    return {
      ...toolDef,
      execute,
      ...(toModelOutput ? { toModelOutput } : {}),
    };
  }

  private describeToolResponse(response: CallToolResult): Record<string, unknown> {
    const parts = Array.isArray(response.content) ? response.content : [];
    let totalTextChars = 0;
    const previews: string[] = [];

    for (const part of parts) {
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        totalTextChars += part.text.length;
        if (previews.length < 2) {
          previews.push(part.text.substring(0, 500));
        }
      }
    }

    return {
      isError: response.isError ?? false,
      parts: parts.length,
      totalTextChars,
      previews,
    };
  }

  private createMcpErrorResult(message: string): CallToolResult {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }

  private isMcpCallToolResult(value: unknown): value is CallToolResult {
    return typeof value === 'object' && value !== null && 'content' in value && Array.isArray(value.content);
  }

  private stripUnsupportedSchemaKeywords(schema: Record<string, unknown>): Record<string, unknown> {
    const unsupportedKeywords = [
      'propertyNames',
      'unevaluatedProperties',
      'dependentSchemas',
      'dependentRequired',
      'contains',
      'contentMediaType',
      'contentEncoding',
      'examples',
      '$defs',
      '$anchor',
      '$recursiveRef',
      '$recursiveAnchor',
    ];

    const processObject = (obj: Record<string, unknown>): Record<string, unknown> => {
      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(obj)) {
        if (unsupportedKeywords.includes(key)) {
          continue;
        }

        if (value !== null && typeof value === 'object') {
          if (Array.isArray(value)) {
            result[key] = value.map((item) => (item !== null && typeof item === 'object' ? processObject(item as Record<string, unknown>) : item));
          } else {
            result[key] = processObject(value as Record<string, unknown>);
          }
        } else {
          result[key] = value;
        }
      }

      return result;
    };

    return processObject(schema);
  }

  private normalizeToolInputSchema(inputSchema: ListToolsResult['tools'][number]['inputSchema']): McpToolInputSchema {
    return {
      ...inputSchema,
      type: (inputSchema.type as string | undefined) ?? 'object',
    } as McpToolInputSchema;
  }

  private fixInputSchema(provider: LlmProviderName, inputSchema: McpToolInputSchema): McpToolInputSchema {
    if (provider === 'gemini') {
      const fixedSchema = JSON.parse(JSON.stringify(inputSchema));

      const strippedSchema = this.stripUnsupportedSchemaKeywords(fixedSchema) as unknown as McpToolInputSchema;

      if (strippedSchema.properties) {
        for (const key of Object.keys(strippedSchema.properties)) {
          let property = strippedSchema.properties[key] as Record<string, unknown>;

          if (property.anyOf) {
            property = { any_of: property.anyOf };
            strippedSchema.properties[key] = property as import('json-schema').JSONSchema7Definition;
          } else if (property.oneOf) {
            property = { one_of: property.oneOf };
            strippedSchema.properties[key] = property as import('json-schema').JSONSchema7Definition;
          } else if (property.allOf) {
            property = { all_of: property.allOf };
            strippedSchema.properties[key] = property as import('json-schema').JSONSchema7Definition;
          } else {
            if (property.default !== undefined) {
              delete property.default;
            }

            if (property.type === 'string' && property.format && !['enum', 'date-time'].includes(property.format as string)) {
              logger.debug(`Removing unsupported format '${property.format}' for property '${key}' in Gemini schema`);
              delete property.format;
            }

            if (!property.type || property.type === 'null') {
              property.type = 'string';
            }
          }
        }
        if (Object.keys(strippedSchema.properties).length === 0) {
          strippedSchema.properties = {
            placeholder: {
              type: 'string',
              description: 'Placeholder property to satisfy Gemini schema requirements',
            },
          };
        }
      }

      return strippedSchema;
    }

    return inputSchema;
  }

  private async initMcpConnectors(
    mcpServers: Record<string, McpServerConfig>,
    projectDir: string | null,
    taskDir: string | null,
    forceReload = false,
    enabledServers?: string[],
  ): Promise<{ connectors: McpConnector[]; failures: McpServerFailure[] }> {
    logger.info('Initializing MCP connectors', {
      projectDir,
      taskDir,
      forceReload,
      enabledServers,
    });
    const initId = uuidv4();
    this.currentInitId = initId;

    const serverNames = enabledServers || Object.keys(mcpServers);
    const pending: { poolKey: string; serverName: string; scope: string; promise: Promise<McpConnector> }[] = [];
    const failures: McpServerFailure[] = [];

    for (const serverName of serverNames) {
      const serverConfig = mcpServers[serverName];
      if (!serverConfig) {
        continue;
      }
      const scope = this.calculateServerScope(serverConfig, projectDir, taskDir, serverName);
      const poolKey = this.getPoolKey(scope, serverName);

      const existingConnector = this.getPooledConnector(scope, serverName);
      const configChanged = !!existingConnector && this.connectorConfigs.get(poolKey) !== JSON.stringify(serverConfig);

      if (forceReload || configChanged) {
        // Config changes and manual force reloads clear quarantine and invalidate
        // the cached tools before reconnecting.
        this.clearQuarantine(poolKey);
        delete this.toolsCache.servers[serverName];
      } else {
        const quarantined = this.getActiveQuarantine(poolKey);
        if (quarantined) {
          logger.debug(`Skipping quarantined MCP server ${serverName}; next retry after ${new Date(quarantined.nextRetryAt).toISOString()}`);
          // Surface the existing failure so the task sees a visible warning on
          // every run during the backoff window.
          failures.push(quarantined);
          continue;
        }
      }

      if (!existingConnector || forceReload || configChanged) {
        const promise = this.initMcpConnector(projectDir, taskDir, serverName, serverConfig, forceReload, initId, scope);
        // Mark the rejection as handled the moment the promise exists. It is consumed by the
        // allSettled below; without this, a server that fails before that point raises an
        // unhandled rejection and Node terminates the process.
        promise.catch(() => undefined);
        this.setPooledConnector(scope, serverName, promise, serverConfig);
        pending.push({ poolKey, serverName, scope, promise });
      }
    }

    const results = await Promise.allSettled(pending.map((entry) => entry.promise));
    let initializedAny = false;
    results.forEach((result, index) => {
      const { poolKey, serverName, scope, promise } = pending[index];
      if (result.status === 'fulfilled') {
        initializedAny = true;
        this.clearQuarantine(poolKey);
        this.updateToolsCache(serverName, result.value.tools);
        return;
      }
      logger.error(`Failed to initialize MCP connector for server ${serverName}:`, result.reason);
      if (this.mcpConnectors.get(poolKey) === promise) {
        failures.push(this.markFailed(poolKey, serverName, scope, result.reason));
      }
    });

    if (initializedAny) {
      await this.saveToolsCache();
    }

    const pooled: Promise<McpConnector>[] = [];
    for (const serverName of serverNames) {
      const serverConfig = mcpServers[serverName];
      if (!serverConfig) {
        continue;
      }
      const scope = this.calculateServerScope(serverConfig, projectDir, taskDir, serverName);
      const connector = this.getPooledConnector(scope, serverName);
      if (connector) {
        pooled.push(connector);
      }
    }

    const settled = await Promise.allSettled(pooled);
    const connectors = settled.filter((result): result is PromiseFulfilledResult<McpConnector> => result.status === 'fulfilled').map((result) => result.value);
    return { connectors, failures };
  }

  private async initMcpConnector(
    projectDir: string | null,
    taskDir: string | null,
    serverName: string,
    config: McpServerConfig,
    forceReload = false,
    initId?: string,
    scope: string = 'global',
  ): Promise<McpConnector> {
    const oldConnectorPromise = this.getPooledConnector(scope, serverName);

    config = this.interpolateServerConfig(config, projectDir, taskDir);

    let oldConnector: McpConnector | null = null;
    if (oldConnectorPromise) {
      try {
        oldConnector = await oldConnectorPromise;

        if (initId !== this.currentInitId) {
          logger.info('MCP initialization aborted as a new request has been received.');
          return oldConnector;
        }
      } catch (error) {
        logger.warn(`Error retrieving old MCP connector for server ${serverName}:`, error);
      }

      if (oldConnector && (forceReload || !this.compareServerConfig(oldConnector.serverConfig, config))) {
        try {
          await oldConnector.client.close();
          logger.info(`Closed old MCP connector for server: ${serverName}`);
          oldConnector = null;
        } catch (closeError) {
          logger.error(`Error closing old MCP connector for server ${serverName}:`, closeError);
        }
      }
    }

    if (oldConnector) {
      logger.debug(`Using existing MCP connector for server: ${serverName}`);
      return oldConnector;
    }

    return this.createMcpConnector(serverName, config, projectDir, taskDir, this.getPoolKey(scope, serverName)).catch((error) => {
      logger.error(`MCP Client creation failed for server during init: ${serverName}`, error);
      throw error;
    });
  }

  async close(): Promise<void> {
    await this.closeAllPooledConnectors();
    logger.debug('MCP clients closed and record cleared/updated.');
  }

  private interpolateServerConfig(serverConfig: McpServerConfig, projectDir: string | null, taskDir: string | null): McpServerConfig {
    const config = JSON.parse(JSON.stringify(serverConfig)) as McpServerConfig;

    const interpolateValue = (value: string): string => {
      let result = value.replace(/\${projectDir}/g, projectDir || '.');
      result = result.replace(/\${taskDir}/g, taskDir || projectDir || '.');
      return result;
    };

    if (config.env) {
      const newEnv: Record<string, string> = {};

      Object.keys(config.env).forEach((key) => {
        if (typeof config.env![key] === 'string') {
          newEnv[key] = interpolateValue(config.env![key]);
        } else {
          newEnv[key] = config.env![key];
        }
      });

      config.env = newEnv;
    }

    if (config.args) {
      config.args = config.args.map(interpolateValue);
    }

    return config;
  }

  private hasInterpolation(value: string, pattern: string): boolean {
    return value.includes(pattern);
  }

  private configHasInterpolation(serverConfig: McpServerConfig, pattern: string): boolean {
    if (serverConfig.command && this.hasInterpolation(serverConfig.command, pattern)) {
      return true;
    }
    if (serverConfig.url && this.hasInterpolation(serverConfig.url, pattern)) {
      return true;
    }
    if (serverConfig.args) {
      for (const arg of serverConfig.args) {
        if (typeof arg === 'string' && this.hasInterpolation(arg, pattern)) {
          return true;
        }
      }
    }
    if (serverConfig.env) {
      for (const envValue of Object.values(serverConfig.env)) {
        if (typeof envValue === 'string' && this.hasInterpolation(envValue, pattern)) {
          return true;
        }
      }
    }
    if (serverConfig.headers) {
      for (const headerValue of Object.values(serverConfig.headers)) {
        if (typeof headerValue === 'string' && this.hasInterpolation(headerValue, pattern)) {
          return true;
        }
      }
    }
    return false;
  }

  private calculateServerScope(serverConfig: McpServerConfig, projectDir: string | null, taskDir: string | null, serverName: string): string {
    const hasProjectDirInterpolation = this.configHasInterpolation(serverConfig, '${projectDir}');
    const hasTaskDirInterpolation = this.configHasInterpolation(serverConfig, '${taskDir}');

    let scope: string;
    if (!hasProjectDirInterpolation && !hasTaskDirInterpolation) {
      scope = !serverConfig.command && serverConfig.url ? 'global' : taskDir || projectDir || 'global';
    } else if (hasProjectDirInterpolation && !hasTaskDirInterpolation) {
      // Has ${projectDir} only: scope = ${projectDir || 'global'}
      scope = projectDir || 'global';
    } else {
      // Has both ${projectDir} and ${taskDir}: scope = ${projectDir}:${taskDir}
      scope = projectDir ? `${projectDir}:${taskDir || ''}` : 'global';
    }

    logger.info(`Calculated scope for MCP server: ${serverName}`, {
      scope,
      hasProjectDirInterpolation,
      hasTaskDirInterpolation,
      projectDir,
      taskDir,
    });

    return scope;
  }

  private createClient(transport: McpClientTransport): Promise<MCPClient> {
    return createMCPClient({
      transport,
      clientName: 'aider-desk-client',
      version: '1.0.0',
    });
  }

  private async createMcpConnector(
    serverName: string,
    config: McpServerConfig,
    projectDir: string | null,
    taskDir: string | null,
    poolKey: string,
  ): Promise<McpConnector> {
    logger.info(`Initializing MCP client for server: ${serverName}`);
    logger.debug(`Server configuration: ${JSON.stringify(config)}`);

    // Held outside the timed block so anything created before a failure or timeout is torn down.
    const handles: { client: MCPClient | null; transport: { close: () => Promise<void> } | null } = { client: null, transport: null };

    const connect = async (): Promise<McpConnector> => {
      if (config.command) {
        const env = { ...config.env };
        if (!env.PATH && process.env.PATH) {
          env.PATH = process.env.PATH;
        }
        if (!env.HOME && process.env.HOME) {
          env.HOME = process.env.HOME;
        }

        let command = config.command;
        let args = config.args || [];
        if (process.platform === 'win32' && command === 'npx') {
          command = 'cmd.exe';
          args = ['/c', 'npx', ...args];
        }

        // If command is 'docker', ensure '--init' is present after 'run'
        // so the container properly handles SIGINT and SIGTERM
        if (command === 'docker') {
          let runSubcommandIndex = -1;

          // Find the index of 'run'. This handles both 'docker run' and 'docker container run'.
          const runIndex = args.indexOf('run');

          if (runIndex !== -1) {
            // Verify it's likely the actual 'run' subcommand
            // e.g., 'run' is the first arg, or it follows 'container'
            if (runIndex === 0 || (runIndex === 1 && args[0] === 'container')) {
              runSubcommandIndex = runIndex;
            }
          }

          if (runSubcommandIndex !== -1) {
            if (!args.includes('--init')) {
              args.splice(runSubcommandIndex + 1, 0, '--init');
              logger.debug(`Added '--init' flag after 'run' for server ${serverName} docker command.`);
            }
          } else {
            logger.warn(`Could not find 'run' subcommand at the expected position in docker args for server ${serverName} from config.`);
          }
        }

        const transport = new StdioClientTransport({
          command,
          args,
          env,
          cwd: taskDir || projectDir || undefined,
        });
        handles.transport = transport;

        logger.debug(`Connecting to MCP server using STDIO: ${serverName}`);
        const stdioClient = await this.createClient(transport);
        handles.client = stdioClient;
        // The AI SDK client set transport.onclose in its constructor; chain onto it so an
        // unexpected exit of the server process evicts the pooled connector immediately.
        const sdkOnClose = transport.onclose;
        transport.onclose = () => {
          sdkOnClose?.();
          this.handleTransportClosed(poolKey, serverName, stdioClient);
        };
        logger.debug(`Connected to MCP server: ${serverName}`);
      } else if (config.url) {
        const headers = config.headers ? { ...config.headers } : undefined;
        const oauthProvider = await this.oauthManager.getProvider(config.url);
        const mcpSdkOAuthProvider = await this.oauthManager.getMcpSdkProvider(config.url);
        const validatedFetch = this.oauthManager.createValidatedFetch(config.url);
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers, redirect: 'error' },
          authProvider: mcpSdkOAuthProvider,
          fetch: validatedFetch,
        });
        handles.transport = transport;

        try {
          logger.debug(`Connecting to MCP server using Streamable HTTP: ${serverName}`);
          handles.client = await this.createClient(transport);
          logger.debug(`Connected to MCP server: ${serverName}`);
        } catch (error) {
          if (error instanceof McpSdkUnauthorizedError) {
            throw new McpAuthenticationRequiredError(serverName, this.getLanguage());
          }

          logger.debug(`Failed to connect to MCP server using Streamable HTTP: ${serverName}`, { message: (error as Error).message });
          await transport.close().catch(() => undefined);
          handles.transport = null;
          logger.debug(`Connecting to MCP server using SSE: ${serverName}`);
          try {
            handles.client = await this.createClient({
              type: 'sse',
              url: config.url,
              headers,
              authProvider: oauthProvider,
              redirect: 'error',
              fetch: validatedFetch,
            });
            logger.debug(`Connected to MCP server: ${serverName}`);
          } catch (sseError) {
            if (sseError instanceof AiSdkUnauthorizedError) {
              throw new McpAuthenticationRequiredError(serverName, this.getLanguage());
            }
            throw sseError;
          }
        }
      } else {
        throw new Error(`MCP server ${serverName} has invalid configuration: missing command or url`);
      }

      const client = handles.client;
      if (!client) {
        throw new Error(`MCP server ${serverName} did not produce a client`);
      }

      logger.debug(`Fetching tools for MCP server: ${serverName}`);
      const toolsResponse = await client.listTools({
        options: { timeout: MCP_INIT_TIMEOUT },
      });
      const toolsList = toolsResponse.tools;
      logger.debug(`Found ${toolsList.length} tools for MCP server: ${serverName}`);

      return {
        client,
        serverName,
        poolKey,
        serverConfig: config,
        projectDir,
        taskDir,
        toolDefinitions: toolsResponse,
        tools: toolsList.map((tool) => ({
          serverName,
          name: tool.name,
          description: tool.description,
          inputSchema: this.normalizeToolInputSchema(tool.inputSchema),
        })),
      };
    };

    let settled = false;
    const connectPromise = connect();

    // The timeout does not cancel the underlying connect(). If the timeout or an
    // earlier failure wins, close the client as soon as the late connect() settles
    // so a late connector cannot leak a live client/process.
    connectPromise.then(
      (connector) => {
        if (settled) {
          connector.client.close().catch(() => undefined);
        }
      },
      () => undefined,
    );

    try {
      const connector = await this.withTimeout(connectPromise, MCP_INIT_TIMEOUT, `MCP server '${serverName}' did not become ready within ${MCP_INIT_TIMEOUT / 1000}s`);
      settled = true;
      logger.info(`MCP client initialized successfully for server: ${serverName}`);
      return connector;
    } catch (error) {
      settled = true;
      await handles.client?.close().catch(() => undefined);
      await handles.transport?.close().catch(() => undefined);
      throw error;
    }
  }

  async getMcpServerTools(
    serverName: string,
    config?: McpServerConfig,
    projectDir: string | null = null,
    taskDir: string | null = null,
  ): Promise<McpTool[] | null> {
    const scope = config ? this.calculateServerScope(config, projectDir, taskDir, serverName) : 'global';
    const poolKey = this.getPoolKey(scope, serverName);

    const failure = this.quarantine.get(poolKey);
    if (failure && Date.now() < failure.nextRetryAt) {
      throw new Error(
        `Unavailable after ${failure.attempts} failed attempt(s); next retry after ${new Date(failure.nextRetryAt).toLocaleTimeString()}. Last error: ${failure.message}`,
      );
    }

    const configMatches = !config || this.connectorConfigs.get(poolKey) === JSON.stringify(config);

    // A cache hit is only valid when the pooled connector was created from the
    // same config; otherwise the cached tools may be stale and we reconnect.
    const cachedTools = this.getCachedTools(serverName);
    if (cachedTools && configMatches) {
      return cachedTools;
    }

    let connectorPromise = this.getPooledConnector(scope, serverName);
    if (connectorPromise && !configMatches) {
      // The pooled connector was created from a different config: close it and
      // reconnect with the requested config instead of reusing stale tools.
      try {
        const staleConnector = await connectorPromise;
        await staleConnector.client.close();
      } catch (error) {
        logger.debug(`Error closing stale connector for server ${serverName}:`, error);
      }
      if (this.mcpConnectors.get(poolKey) === connectorPromise) {
        this.mcpConnectors.delete(poolKey);
        this.connectorServerUrls.delete(poolKey);
        this.connectorConfigs.delete(poolKey);
      }
      connectorPromise = undefined;
    }
    if (!connectorPromise && config) {
      connectorPromise = this.initMcpConnector(projectDir, taskDir, serverName, config, false, undefined, scope);
      connectorPromise.catch(() => undefined);
      this.setPooledConnector(scope, serverName, connectorPromise, config);
    }
    if (!connectorPromise) {
      logger.warn(`No MCP client promise found for server: ${serverName}`);
      return null;
    }
    try {
      const connector = await connectorPromise;
      this.clearQuarantine(poolKey);
      return connector.tools;
    } catch (error) {
      logger.error(`Error retrieving tools for MCP server ${serverName}, client promise rejected:`, error);
      if (this.mcpConnectors.get(poolKey) === connectorPromise) {
        // A failed settings probe must not quarantine the server or poison a
        // healthy persisted draft: evict the rejected promise and its maps only.
        this.mcpConnectors.delete(poolKey);
        this.connectorServerUrls.delete(poolKey);
        this.connectorConfigs.delete(poolKey);
        delete this.toolsCache.servers[serverName];
      }
      throw error;
    }
  }

  async getOAuthStatus(config: McpServerConfig): Promise<McpOAuthStatusData> {
    if (!config.url) {
      return { status: McpOAuthStatus.NotRequired };
    }
    return this.oauthManager.getStatus(config.url);
  }

  async startOAuth(serverName: string, config: McpServerConfig): Promise<string> {
    if (!config.url) {
      throw new Error(`MCP server '${serverName}' does not use a remote URL`);
    }

    let authorizationUrl = await this.oauthManager.startAuthorization(config.url);
    if (!authorizationUrl) {
      try {
        await this.reloadSingleServer(serverName, config);
      } catch (error) {
        if (!(error instanceof McpAuthenticationRequiredError)) {
          throw error;
        }
      }
      authorizationUrl = await this.oauthManager.startAuthorization(config.url);
    }
    if (!authorizationUrl) {
      throw new Error(`MCP server '${serverName}' did not provide an OAuth authorization URL`);
    }
    return authorizationUrl;
  }

  async completeOAuth(code: string, state: string): Promise<void> {
    const serverUrl = await this.oauthManager.completeAuthorization(code, state);
    await this.invalidateConnectorsForUrl(serverUrl);
  }

  async cancelOAuth(state: string): Promise<void> {
    await this.oauthManager.cancelAuthorization(state);
  }

  async disconnectOAuth(config: McpServerConfig): Promise<void> {
    if (!config.url) {
      return;
    }
    await this.oauthManager.disconnect(config.url);
    await this.invalidateConnectorsForUrl(config.url);
  }

  private async invalidateConnectorsForUrl(serverUrl: string): Promise<void> {
    const normalizedUrl = new URL(serverUrl).toString();
    const matchingKeys = Array.from(this.connectorServerUrls.entries())
      .filter(([, connectorUrl]) => connectorUrl === normalizedUrl)
      .map(([poolKey]) => poolKey);

    for (const poolKey of matchingKeys) {
      const connectorPromise = this.mcpConnectors.get(poolKey);
      if (connectorPromise) {
        try {
          const connector = await connectorPromise;
          await connector.client.close();
          delete this.toolsCache.servers[connector.serverName];
        } catch {
          const serverName = poolKey.slice(poolKey.lastIndexOf(':') + 1);
          delete this.toolsCache.servers[serverName];
        }
      }
      // Only delete the entry if it still holds the promise we just awaited, so a
      // newer connector stored at the same pool key is never removed by a stale one.
      if (this.mcpConnectors.get(poolKey) === connectorPromise) {
        this.mcpConnectors.delete(poolKey);
        this.connectorServerUrls.delete(poolKey);
        this.connectorConfigs.delete(poolKey);
        this.quarantine.delete(poolKey);
      }
    }
    await this.saveToolsCache();
  }

  private compareServerConfig(config: McpServerConfig, otherConfig: McpServerConfig) {
    return JSON.stringify(config) === JSON.stringify(otherConfig);
  }

  private async loadToolsCache(): Promise<void> {
    try {
      const cacheFile = MCP_TOOLS_CACHE_FILE;
      await fs.mkdir(AIDER_DESK_CACHE_DIR, { recursive: true });
      await fs.access(cacheFile);
      const cachedData = await fs.readFile(cacheFile, 'utf-8');
      const cachedJson = JSON.parse(cachedData) as McpToolsCache;
      if (cachedJson.version === MCP_TOOLS_CACHE_VERSION) {
        this.toolsCache = cachedJson;
        logger.info('MCP tools cache loaded successfully');
      } else {
        logger.warn('MCP tools cache version mismatch, ignoring');
      }
    } catch {
      logger.debug('MCP tools cache file not found or invalid, starting with empty cache');
      this.toolsCache = { version: MCP_TOOLS_CACHE_VERSION, servers: {} };
    }
  }

  async saveToolsCache(): Promise<void> {
    try {
      await fs.mkdir(AIDER_DESK_CACHE_DIR, { recursive: true });
      await fs.writeFile(MCP_TOOLS_CACHE_FILE, JSON.stringify(this.toolsCache, null, 2));
      logger.debug('MCP tools cache saved successfully');
    } catch (error) {
      logger.error('Error saving MCP tools cache:', error);
    }
  }

  getCachedTools(serverName: string): McpTool[] | null {
    const cacheEntry = this.toolsCache.servers[serverName];
    if (!cacheEntry) {
      return null;
    }
    logger.debug(`Returning cached tools for server: ${serverName}`);
    return cacheEntry.tools;
  }

  updateToolsCache(serverName: string, tools: McpTool[]): void {
    this.toolsCache.servers[serverName] = {
      tools,
      cachedAt: Date.now(),
    };
    logger.debug(`Updated cache for server: ${serverName}`);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    // Consume the original promise's eventual rejection so a late failure after the timeout is not unhandled.
    promise.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private isConnectionClosedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /connection closed|closed client|not connected|transport (is )?closed|EPIPE|ECONNRESET|ECONNREFUSED/i.test(message);
  }

  /** The AI SDK's error for a request issued after its client closed; the request never reached the server. */
  private isClosedClientError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /from a closed client/i.test(message);
  }

  private async resolveLiveConnector(connector: McpConnector): Promise<McpConnector> {
    const pooled = this.mcpConnectors.get(connector.poolKey);
    if (!pooled) {
      return connector;
    }
    try {
      return await pooled;
    } catch {
      return connector;
    }
  }

  private getToolExecute(target: McpConnector, toolDefinition: McpToolDefinition): NonNullable<Tool['execute']> {
    const tool = target.client.toolsFromDefinitions({ tools: [toolDefinition] })[toolDefinition.name];
    if (!tool?.execute) {
      throw new Error(`AI SDK MCP tool ${target.serverName}${TOOL_GROUP_NAME_SEPARATOR}${toolDefinition.name} does not have an execute function`);
    }
    return tool.execute;
  }

  private async reconnectConnector(connector: McpConnector): Promise<McpConnector> {
    const { poolKey, serverName } = connector;
    const scope = poolKey.slice(0, poolKey.length - serverName.length - 1);

    const pooled = this.mcpConnectors.get(poolKey);
    if (pooled) {
      const resolved = await pooled.catch(() => null);
      const current = this.mcpConnectors.get(poolKey);
      if (current && current !== pooled) {
        // Another caller already replaced the connector while we waited.
        return current;
      }
      if (resolved && resolved !== connector) {
        return resolved;
      }
    }

    const configJson = this.connectorConfigs.get(poolKey);
    const poolConfig = configJson ? (JSON.parse(configJson) as McpServerConfig) : connector.serverConfig;
    this.mcpConnectors.delete(poolKey);
    this.connectorServerUrls.delete(poolKey);
    this.connectorConfigs.delete(poolKey);
    connector.client.close().catch(() => undefined);

    logger.warn(`Reconnecting MCP server ${serverName} (${poolKey}) after its client closed`);
    const promise = this.createMcpConnector(serverName, connector.serverConfig, connector.projectDir, connector.taskDir, poolKey);
    promise.catch(() => undefined);
    this.setPooledConnector(scope, serverName, promise, poolConfig);

    try {
      const fresh = await promise;
      this.clearQuarantine(poolKey);
      this.updateToolsCache(serverName, fresh.tools);
      void this.saveToolsCache();
      return fresh;
    } catch (error) {
      if (this.mcpConnectors.get(poolKey) === promise) {
        this.markFailed(poolKey, serverName, scope, error);
      }
      throw error;
    }
  }

  private handleTransportClosed(poolKey: string, serverName: string, client: MCPClient): void {
    const pooled = this.mcpConnectors.get(poolKey);
    if (!pooled) {
      return;
    }
    pooled.then(
      (resolved) => {
        if (resolved.client === client && this.mcpConnectors.get(poolKey) === pooled) {
          this.evictConnector(resolved, `MCP server ${serverName} process exited`);
        }
      },
      () => undefined,
    );
  }

  private markFailed(poolKey: string, serverName: string, scope: string, error: unknown): McpServerFailure {
    const attempts = (this.quarantine.get(poolKey)?.attempts ?? 0) + 1;
    const backoffMs = Math.min(MCP_QUARANTINE_BASE_MS * 2 ** (attempts - 1), MCP_QUARANTINE_MAX_MS);
    const failure: McpServerFailure = {
      serverName,
      scope,
      message: error instanceof Error ? error.message : String(error),
      failedAt: Date.now(),
      attempts,
      nextRetryAt: Date.now() + backoffMs,
    };
    this.mcpConnectors.delete(poolKey);
    this.connectorServerUrls.delete(poolKey);
    this.connectorConfigs.delete(poolKey);
    delete this.toolsCache.servers[serverName];
    if (error instanceof McpAuthenticationRequiredError) {
      // Authentication is not a connectivity outage: do not quarantine, so the
      // OAuth flow can recover immediately after authorization.
      logger.warn(`MCP server ${serverName} requires authentication: ${failure.message}`);
      return failure;
    }
    this.quarantine.set(poolKey, failure);
    logger.warn(`MCP server ${serverName} quarantined after ${attempts} failed attempt(s); next retry in ${Math.round(backoffMs / 1000)}s: ${failure.message}`);
    return failure;
  }

  private clearQuarantine(poolKey: string): void {
    this.quarantine.delete(poolKey);
  }

  private getActiveQuarantine(poolKey: string): McpServerFailure | undefined {
    const failure = this.quarantine.get(poolKey);
    return failure && Date.now() < failure.nextRetryAt ? failure : undefined;
  }

  private quarantineConnector(poolKey: string, serverName: string, error: unknown): void {
    const existing = this.quarantine.get(poolKey);
    if (existing && Date.now() < existing.nextRetryAt) {
      return;
    }
    const failure: McpServerFailure = {
      serverName,
      scope: poolKey.slice(0, poolKey.lastIndexOf(':')),
      message: error instanceof Error ? error.message : String(error),
      failedAt: Date.now(),
      attempts: 1,
      nextRetryAt: Date.now() + MCP_QUARANTINE_BASE_MS,
    };
    this.quarantine.set(poolKey, failure);
    logger.warn(`MCP server ${serverName} quarantined after connection loss; next retry in ${Math.round(MCP_QUARANTINE_BASE_MS / 1000)}s: ${failure.message}`);
  }

  private evictConnector(connector: McpConnector, reason: string): void {
    const pooled = this.mcpConnectors.get(connector.poolKey);
    if (!pooled) {
      return;
    }
    pooled.then(
      (resolved) => {
        if (resolved !== connector || this.mcpConnectors.get(connector.poolKey) !== pooled) {
          return;
        }
        this.mcpConnectors.delete(connector.poolKey);
        this.connectorServerUrls.delete(connector.poolKey);
        this.connectorConfigs.delete(connector.poolKey);
        delete this.toolsCache.servers[connector.serverName];
        logger.warn(`Evicted MCP connector ${connector.poolKey}; it will be reconnected on next use. Reason: ${reason}`);
        connector.client.close().catch(() => undefined);
      },
      () => undefined,
    );
  }

  async removeServer(serverName: string): Promise<void> {
    const suffix = `:${serverName}`;
    for (const [poolKey, connectorPromise] of Array.from(this.mcpConnectors.entries())) {
      if (!poolKey.endsWith(suffix)) {
        continue;
      }
      this.mcpConnectors.delete(poolKey);
      this.connectorServerUrls.delete(poolKey);
      this.connectorConfigs.delete(poolKey);
      try {
        const connector = await connectorPromise;
        await connector.client.close();
        logger.info(`Closed MCP connector ${poolKey} for removed server`);
      } catch (error) {
        logger.debug(`Connector ${poolKey} for removed server was not open:`, error);
      }
    }
    for (const poolKey of Array.from(this.quarantine.keys())) {
      if (poolKey.endsWith(suffix)) {
        this.quarantine.delete(poolKey);
      }
    }
    delete this.toolsCache.servers[serverName];
    await this.saveToolsCache();
  }

  private getPoolKey(scope: string, serverName: string): string {
    return `${scope}:${serverName}`;
  }

  private getPooledConnector(scope: string, serverName: string): Promise<McpConnector> | undefined {
    return this.mcpConnectors.get(this.getPoolKey(scope, serverName));
  }

  private setPooledConnector(scope: string, serverName: string, connector: Promise<McpConnector>, config: McpServerConfig): void {
    const poolKey = this.getPoolKey(scope, serverName);
    this.mcpConnectors.set(poolKey, connector);
    this.connectorConfigs.set(poolKey, JSON.stringify(config));
    this.connectorServerUrls.delete(poolKey);
    if (config.url) {
      try {
        this.connectorServerUrls.set(poolKey, new URL(config.url).toString());
      } catch {
        // Invalid URL: the connector itself will fail and be quarantined.
      }
    }
  }

  private async closeAllPooledConnectors(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [key, connectorPromise] of this.mcpConnectors.entries()) {
      closePromises.push(
        (async () => {
          try {
            const connector = await connectorPromise;
            await connector.client.close();
            logger.debug(`Closed pooled connector for ${key}`);
          } catch (error) {
            logger.error(`Error closing pooled connector for ${key}:`, error);
          }
        })(),
      );
    }
    await Promise.all(closePromises);
    this.mcpConnectors.clear();
    this.connectorServerUrls.clear();
    this.connectorConfigs.clear();
    this.quarantine.clear();
    logger.debug('All pooled connectors closed');
  }

  async reloadAllServers(
    mcpServers: Record<string, McpServerConfig>,
    force: boolean,
    projectDir: string | null = null,
    taskDir: string | null = null,
  ): Promise<void> {
    logger.info('Reloading all MCP servers', { force, projectDir, taskDir });
    if (force) {
      this.toolsCache.servers = {};
    }
    await this.initMcpConnectors(mcpServers, projectDir, taskDir, force);
    logger.info('All MCP servers reloaded');
  }

  async reloadSingleServer(
    serverName: string,
    config: McpServerConfig,
    projectDir: string | null = null,
    taskDir: string | null = null,
  ): Promise<McpTool[]> {
    logger.info(`Reloading single MCP server: ${serverName}`);

    const scope = this.calculateServerScope(config, projectDir, taskDir, serverName);
    const poolKey = this.getPoolKey(scope, serverName);
    this.clearQuarantine(poolKey);

    const connectorPromise = this.getPooledConnector(scope, serverName);
    if (connectorPromise) {
      try {
        const connector = await connectorPromise;
        await connector.client.close();
        logger.debug(`Closed connector for server: ${serverName}`);
      } catch (error) {
        logger.error(`Error closing connector for server ${serverName}:`, error);
      }
      // Only remove the entry if it still holds the promise we just awaited, so a
      // newer connector stored at the same pool key is never deleted by a stale one.
      if (this.mcpConnectors.get(poolKey) === connectorPromise) {
        this.mcpConnectors.delete(poolKey);
        this.connectorServerUrls.delete(poolKey);
        this.connectorConfigs.delete(poolKey);
      }
    }

    delete this.toolsCache.servers[serverName];

    const newConnectorPromise = this.initMcpConnector(projectDir, taskDir, serverName, config, false, undefined, scope);
    this.setPooledConnector(scope, serverName, newConnectorPromise, config);

    try {
      const connector = await newConnectorPromise;
      this.updateToolsCache(serverName, connector.tools);
      await this.saveToolsCache();
      logger.info(`Successfully reloaded MCP server: ${serverName}`);
      return connector.tools;
    } catch (error) {
      logger.error(`Failed to reload MCP server ${serverName}:`, error);
      if (this.mcpConnectors.get(poolKey) === newConnectorPromise) {
        this.markFailed(poolKey, serverName, scope, error);
      }
      throw error;
    }
  }
}
