vi.mock('@/logger');

const fakeTransports = vi.hoisted(() => [] as Array<{ onclose?: () => void }>);

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class FakeStdioClientTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    constructor() {
      fakeTransports.push(this);
    }

    async start() {}

    async close() {
      this.onclose?.();
    }

    async send(message: { id?: string | number; method?: string }) {
      if (message.id === undefined) {
        return;
      }
      if (message.method === 'initialize') {
        queueMicrotask(() =>
          this.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1.0.0' } },
          }),
        );
      } else if (message.method === 'tools/list') {
        queueMicrotask(() =>
          this.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] },
          }),
        );
      }
    }
  }
  return { StdioClientTransport: FakeStdioClientTransport };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMCPClient, type JSONRPCMessage, type ListToolsResult, type MCPClient, type MCPTransport } from '@ai-sdk/mcp';
import { type Tool, type ToolExecutionOptions } from 'ai';
import { TOOL_GROUP_NAME_SEPARATOR } from '@common/tools';
import { type AgentProfile, type McpServerConfig } from '@common/types';

import { McpManager, type McpServerFailure } from '../mcp-manager';
import { type ApprovalManager } from '../tools/approval-manager';

import { type Task } from '@/task';

const SERVER = 'test-server';
const POOL_KEY = `/project/task:${SERVER}`;
const CONFIG: McpServerConfig = { command: 'fake-command' };

type ManagerInternals = {
  mcpConnectors: Map<string, Promise<unknown>>;
  connectorConfigs: Map<string, string>;
  quarantine: Map<string, McpServerFailure>;
  initMcpConnectors: (...args: unknown[]) => Promise<{ connectors: unknown[]; failures: McpServerFailure[] }>;
  createMcpConnector: (...args: unknown[]) => Promise<unknown>;
};

const internals = (manager: McpManager) => manager as unknown as ManagerInternals;

const definitions: ListToolsResult = {
  tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
};

const createConnector = (client: MCPClient) => ({
  client,
  serverName: SERVER,
  poolKey: POOL_KEY,
  serverConfig: CONFIG,
  projectDir: '/project',
  taskDir: '/project/task',
  toolDefinitions: definitions,
  tools: [{ serverName: SERVER, name: 'ping', inputSchema: definitions.tools[0].inputSchema }],
});

const createProfile = (): AgentProfile =>
  ({
    enabledServers: [SERVER],
    toolApprovals: {},
    minTimeBetweenToolCalls: 0,
  }) as unknown as AgentProfile;

const createTask = (): Task =>
  ({
    project: {
      getSettings: vi.fn(() => ({ mcpServers: {} })),
    },
    getProjectDir: vi.fn(() => '/project'),
    getTaskDir: vi.fn(() => '/project/task'),
    addLogMessage: vi.fn(),
    addToolMessage: vi.fn(),
  }) as unknown as Task;

const createApprovalManager = () =>
  ({
    handleToolApproval: vi.fn(async () => [true, undefined]),
  }) as unknown as ApprovalManager;

const execOptions = () => ({ toolCallId: 'call-1', messages: [], context: undefined }) as unknown as ToolExecutionOptions<unknown>;

const createTestClient = async () => {
  const calls: JSONRPCMessage[] = [];
  const transport: MCPTransport = {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    send: vi.fn(async (message) => {
      calls.push(message);
      if ('method' in message && message.method === 'initialize' && 'id' in message) {
        queueMicrotask(() =>
          transport.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '1.0.0' } },
          }),
        );
      }
      if ('method' in message && message.method === 'tools/call' && 'id' in message) {
        queueMicrotask(() =>
          transport.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: 'done' }] },
          }),
        );
      }
    }),
  };
  const client = await createMCPClient({ transport, clientName: 'test-client', version: '1.0.0' });
  const sentToolCall = () => calls.some((message) => 'method' in message && message.method === 'tools/call');
  return { client, sentToolCall };
};

const buildPingTool = async (manager: McpManager, connector: ReturnType<typeof createConnector>) => {
  internals(manager).mcpConnectors.set(POOL_KEY, Promise.resolve(connector));
  internals(manager).connectorConfigs.set(POOL_KEY, JSON.stringify(CONFIG));
  vi.spyOn(internals(manager), 'initMcpConnectors').mockResolvedValue({ connectors: [connector], failures: [] });
  const toolSet = await manager.createToolset(createTask(), createProfile(), 'openai', {}, createApprovalManager());
  return toolSet[`${SERVER}${TOOL_GROUP_NAME_SEPARATOR}ping`] as Tool;
};

describe('McpManager - recovery from a closed MCP client', () => {
  let manager: McpManager;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeTransports.length = 0;
    manager = new McpManager();
    vi.spyOn(manager, 'saveToolsCache').mockResolvedValue(undefined);
  });

  it('reconnects and retries once when the pooled client has been closed', async () => {
    const dead = await createTestClient();
    const fresh = await createTestClient();
    const freshConnector = createConnector(fresh.client);
    const tool = await buildPingTool(manager, createConnector(dead.client));
    await dead.client.close();
    const createSpy = vi.spyOn(internals(manager), 'createMcpConnector').mockResolvedValue(freshConnector);

    const result = await tool.execute?.({}, execOptions());

    expect(result).toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(SERVER, CONFIG, '/project', '/project/task', POOL_KEY);
    expect(internals(manager).quarantine.size).toBe(0);
    await expect(internals(manager).mcpConnectors.get(POOL_KEY)).resolves.toBe(freshConnector);
    expect(fresh.sentToolCall()).toBe(true);
    await fresh.client.close();
  });

  it('uses the connector currently in the pool rather than the one the toolset was built with', async () => {
    const old = await createTestClient();
    const current = await createTestClient();
    const tool = await buildPingTool(manager, createConnector(old.client));
    internals(manager).mcpConnectors.set(POOL_KEY, Promise.resolve(createConnector(current.client)));
    await old.client.close();
    const createSpy = vi.spyOn(internals(manager), 'createMcpConnector');

    const result = await tool.execute?.({}, execOptions());

    expect(result).toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    expect(createSpy).not.toHaveBeenCalled();
    expect(current.sentToolCall()).toBe(true);
    expect(old.sentToolCall()).toBe(false);
    await current.client.close();
  });

  it('evicts the pooled connector when the stdio server process exits', async () => {
    const { connectors } = await internals(manager).initMcpConnectors({ [SERVER]: CONFIG }, '/project', '/project/task', false, [SERVER]);
    expect(connectors).toHaveLength(1);
    expect(internals(manager).mcpConnectors.has(POOL_KEY)).toBe(true);
    expect(fakeTransports).toHaveLength(1);

    fakeTransports[0].onclose?.();

    await vi.waitFor(() => expect(internals(manager).mcpConnectors.has(POOL_KEY)).toBe(false));
    expect(internals(manager).quarantine.size).toBe(0);
  });
});
