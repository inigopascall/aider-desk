/**
 * Tests for Agent class - specifically getContextFilesAsToolCallMessages method
 */

// Mock dependencies
vi.mock('@/logger');
vi.mock('istextorbinary', () => ({
  isBinary: vi.fn(),
}));
vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));
vi.mock('fs/promises');
vi.mock('uuid', () => ({
  v4: vi.fn(),
}));

// Mock the AI SDK so runAgent lifecycle tests never make real model calls.
// The mock functions are shared across the whole file; only the runAgent
// lifecycle tests install implementations on them.
const {
  mockStreamText,
  mockGenerateText,
  mockSmoothStream,
  mockWrapLanguageModel,
  mockTool,
  mockAPICallError,
  mockNoSuchToolError,
  mockInvalidToolInputError,
  mockOutput,
  mockParsePartialJson,
} = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockGenerateText: vi.fn(),
  mockSmoothStream: vi.fn(),
  mockWrapLanguageModel: vi.fn(({ model }: any) => model),
  mockTool: vi.fn((def: any) => def),
  mockAPICallError: { isInstance: vi.fn(() => false) },
  mockNoSuchToolError: { isInstance: vi.fn(() => false) },
  mockInvalidToolInputError: { isInstance: vi.fn(() => false) },
  mockOutput: { object: vi.fn() },
  mockParsePartialJson: vi.fn(),
}));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  generateText: mockGenerateText,
  smoothStream: mockSmoothStream,
  wrapLanguageModel: mockWrapLanguageModel,
  tool: mockTool,
  APICallError: mockAPICallError,
  NoSuchToolError: mockNoSuchToolError,
  InvalidToolInputError: mockInvalidToolInputError,
  Output: mockOutput,
  parsePartialJson: mockParsePartialJson,
}));

// Type declarations for mocked modules without type declarations
declare global {
  // file-type has types but we mock it
  const fileTypeFromBuffer: (buffer: Buffer) => Promise<{ ext: string; mime: string } | undefined>;
}

// Import dependencies
import * as fs from 'fs/promises';
import path from 'path';

// @ts-expect-error istextorbinary is not typed properly
import { isBinary } from 'istextorbinary';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextCompactionType, DefaultTaskState, ToolApprovalState } from '@common/types';
import { POWER_TOOL_FILE_READ, POWER_TOOL_GROUP_NAME, TOOL_GROUP_NAME_SEPARATOR } from '@common/tools';
import { fileTypeFromBuffer } from 'file-type';
import { v4 as uuidv4 } from 'uuid';

import type { ContextAssistantMessage, ContextFile, ContextMessage } from '@common/types';

// Re-export types that are needed
import { AIDER_DESK_PROJECT_RULES_DIR } from '@/constants';
import { createMockAgentProfile, createMockTask } from '@/__tests__/mocks';

// We need to import Agent after mocks are set up
const AgentModule = await import('../agent');
const { Agent: AgentClass } = AgentModule;

// Add Agent type since we're using it
type Agent = InstanceType<typeof AgentClass>;

const fileReadToolId = `${POWER_TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${POWER_TOOL_FILE_READ}`;

describe('Agent - getContextFilesAsToolCallMessages', () => {
  let agent: Agent;
  let mockTask: ReturnType<typeof createMockTask>;
  let mockProfile: ReturnType<typeof createMockAgentProfile>;
  let mockFsReadFile: ReturnType<typeof vi.mocked<typeof fs.readFile>>;
  let mockIsBinary: ReturnType<typeof vi.mocked<typeof isBinary>>;
  let mockFileTypeFromBuffer: ReturnType<typeof vi.mocked<typeof fileTypeFromBuffer>>;
  let mockUuidv4: ReturnType<typeof vi.mocked<typeof uuidv4>>;

  // Store original implementation
  let originalGetContextFilesMessages: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup basic mocks
    mockFsReadFile = vi.mocked(fs.readFile);
    mockIsBinary = vi.mocked(isBinary);
    mockFileTypeFromBuffer = vi.mocked(fileTypeFromBuffer);
    mockUuidv4 = vi.mocked(uuidv4);

    mockTask = createMockTask();
    mockProfile = createMockAgentProfile({
      useAiderTools: true,
    });

    // Setup uuid to return predictable IDs
    let uuidCounter = 1;
    mockUuidv4.mockImplementation(() => `uuid-${uuidCounter++}` as any);

    // Default mocks for file operations
    (mockIsBinary as any).mockReturnValue(false);
    mockFileTypeFromBuffer.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(Buffer.from('file content') as any);

    // Create minimal mocks for Agent constructor dependencies
    const mockStore = {
      getSettings: vi.fn(() => ({})),
    };
    const mockAgentProfileManager = {};
    const mockMcpManager = {
      getConnectors: vi.fn(() => []),
    };
    const mockMcpConfigManager = {
      getMergedServers: vi.fn(() => ({})),
    };
    const mockModelManager = {
      createLlm: vi.fn(),
      getProviderOptions: vi.fn(() => ({})),
      getProviderParameters: vi.fn(() => ({})),
      getCacheControl: vi.fn(() => ({})),
      getModelSettings: vi.fn(() => undefined),
      getProviderTools: vi.fn(() => Promise.resolve({})),
      isStreamingDisabled: vi.fn(() => false),
    };
    const mockTelemetryManager = {
      captureAgentRun: vi.fn(),
    };
    const mockMemoryManager = {};
    const mockPromptsManager = {};
    const mockExtensionManager = {
      isInitialized: vi.fn(() => false),
      createExtensionToolset: vi.fn(() => ({})),
    };

    agent = new AgentClass(
      mockStore as any,
      mockAgentProfileManager as any,
      mockMcpManager as any,
      mockMcpConfigManager as any,
      mockModelManager as any,
      mockTelemetryManager as any,
      mockMemoryManager as any,
      mockPromptsManager as any,
      mockExtensionManager as any,
    );

    // Spy on the private method for testing
    // Note: This is accessing a private method, which is acceptable for unit testing
    // Store original implementation for fallback mode tests
    originalGetContextFilesMessages = agent['getContextFilesMessages'];
    agent['getContextFilesMessages'] = vi.fn();
  });

  afterEach(() => {
    // Restore original method
    if (originalGetContextFilesMessages) {
      agent['getContextFilesMessages'] = originalGetContextFilesMessages;
    }
  });

  describe('Mode Selection', () => {
    it('should call getContextFilesMessages (fallback) when power:file_read approval is Never', async () => {
      // Setup profile with Never approval for file_read
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Never,
      };

      // Restore original method to verify it gets called
      agent['getContextFilesMessages'] = originalGetContextFilesMessages;
      const getContextFilesMessagesSpy = vi.spyOn(agent as any, 'getContextFilesMessages');

      const contextFiles: ContextFile[] = [{ path: 'test.txt', readOnly: true }];

      await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      expect(getContextFilesMessagesSpy).toHaveBeenCalledWith(mockTask, mockProfile, contextFiles);
    });

    it('should use tool call mode when power:file_read approval is not Never (Always)', async () => {
      // Setup profile with Always approval for file_read
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [{ path: 'test.txt', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('test content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Each file gets its own assistant message (with text and tool-call) followed by a tool message
      expect(result).toHaveLength(2); // assistant message + tool result message
      expect(result[0].role).toBe('assistant');
      expect(Array.isArray(result[0].content)).toBe(true);
      expect((result[0].content as any)[0].type).toBe('text');
      expect((result[0].content as any)[1].type).toBe('tool-call');
      expect(result[1].role).toBe('tool');
      expect(Array.isArray(result[1].content)).toBe(true);
      expect((result[1].content as any)[0].type).toBe('tool-result');
    });

    it('should use tool call mode when power:file_read approval is not Never (Ask)', async () => {
      // Setup profile with Ask approval for file_read
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Ask,
      };

      const contextFiles: ContextFile[] = [{ path: 'test.txt', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('test content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('assistant');
      expect(Array.isArray(result[0].content)).toBe(true);
      expect((result[0].content as any)[1].type).toBe('tool-call');
      expect(result[1].role).toBe('tool');
      expect((result[1].content as any)[0].type).toBe('tool-result');
    });

    it('should use tool call mode when file_read tool approval is undefined', async () => {
      // Setup profile with no approval set for file_read (undefined)
      mockProfile.toolApprovals = {};

      const contextFiles: ContextFile[] = [{ path: 'test.txt', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('test content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('assistant');
    });
  });

  describe('Tool Call Mode - Read-Only Files', () => {
    it('should generate assistant message with tool calls for read-only files', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [
        { path: 'readonly1.txt', readOnly: true },
        { path: 'readonly2.txt', readOnly: true },
      ];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content 1')).mockResolvedValueOnce(Buffer.from('content 2'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Each file gets its own assistant+tool result pair: 2 files * 2 messages = 4 messages
      expect(result.length).toBe(4);

      // Find assistant messages
      const assistantMessages = result.filter((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content) && (msg.content as any)[0].type === 'text');
      expect(assistantMessages).toHaveLength(2);

      // Verify the description mentions read-only for each
      for (const assistantMessage of assistantMessages) {
        const textContent = (assistantMessage.content as any)[0].text;
        expect(textContent).toContain('read-only');
        expect(textContent).toContain('reference material');
      }
    });

    it('should generate corresponding tool messages with tool results containing file content', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [{ path: 'readonly.txt', readOnly: true }];

      const expectedContent = 'test file content';
      // Implementation calls fs.readFile twice: once for binary detection, once in readFileContent
      mockFsReadFile.mockReset().mockResolvedValueOnce(Buffer.from(expectedContent)).mockResolvedValueOnce(Buffer.from(expectedContent));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should have 2 messages: assistant + tool result
      expect(result).toHaveLength(2);

      // Find tool result message
      const toolResultMessage = result.find((msg: any) => msg.role === 'tool');
      expect(toolResultMessage).toBeDefined();

      // Verify tool result contains the file content
      if (!toolResultMessage) {
        return;
      }
      const toolResultPart = (toolResultMessage.content as any)[0];
      expect(toolResultPart.type).toBe('tool-result');
      expect(toolResultPart.toolName).toBe(fileReadToolId);
      expect(toolResultPart.output.type).toBe('text');
      // Content should have line numbers added by readFileContent(withLines: true)
      expect(toolResultPart.output.value).toContain('1|test file content');
    });

    it('should use appropriate description when useAiderTools is false', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };
      mockProfile.useAiderTools = false;

      const contextFiles: ContextFile[] = [{ path: 'readonly.txt', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      const assistantMessage = result.find((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content));
      expect(assistantMessage).toBeDefined();
      if (!assistantMessage) {
        return;
      }
      const textContent = (assistantMessage.content as any)[0].text;

      // Should mention read-only but not Aider
      expect(textContent).toContain('read-only');
      expect(textContent).not.toContain('Aider context');
    });
  });

  describe('Tool Call Mode - Editable Files', () => {
    it('should generate assistant message with tool calls for editable files', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [
        { path: 'editable1.ts', readOnly: false },
        { path: 'editable2.ts', readOnly: false },
      ];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('code 1')).mockResolvedValueOnce(Buffer.from('code 2'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Each file gets its own assistant+tool result pair: 2 files * 2 messages = 4 messages
      expect(result.length).toBe(4);

      // Find assistant messages
      const assistantMessages = result.filter((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content) && (msg.content as any)[0].type === 'text');
      expect(assistantMessages).toHaveLength(2);

      // Verify the description mentions editable
      for (const assistantMessage of assistantMessages) {
        const textContent = (assistantMessage.content as any)[0].text;
        expect(textContent).toContain('can be edited');
      }
    });

    it('should generate corresponding tool messages with tool results for editable files', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [{ path: 'editable.ts', readOnly: false }];

      const expectedContent = 'export const test = 42;';
      // Implementation calls fs.readFile twice: once for binary detection, once in readFileContent
      mockFsReadFile.mockReset().mockResolvedValueOnce(Buffer.from(expectedContent)).mockResolvedValueOnce(Buffer.from(expectedContent));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should have 2 messages: assistant + tool result
      expect(result).toHaveLength(2);

      // Find tool result message
      const toolResultMessage = result.find((msg: any) => msg.role === 'tool');
      expect(toolResultMessage).toBeDefined();

      // Verify tool result contains the file content
      if (!toolResultMessage) {
        return;
      }
      const toolResultPart = (toolResultMessage.content as any)[0];
      expect(toolResultPart.type).toBe('tool-result');
      expect(toolResultPart.output.type).toBe('text');
      // Content should have line numbers added by readFileContent(withLines: true)
      expect(toolResultPart.output.value).toContain('1|export const test = 42;');
    });

    it('should use appropriate description when useAiderTools is false for editable files', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };
      mockProfile.useAiderTools = false;

      const contextFiles: ContextFile[] = [{ path: 'editable.ts', readOnly: false }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      const assistantMessage = result.find((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content));
      expect(assistantMessage).toBeDefined();
      if (!assistantMessage) {
        return;
      }
      const textContent = (assistantMessage.content as any)[0].text;

      // Should mention editable but not Aider
      expect(textContent).toContain('can be edited');
      expect(textContent).not.toContain('Aider context');
    });
  });

  describe('Tool Call Mode - Mixed Files', () => {
    it('should maintain correct ordering: read-only files first, then editable files', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [
        { path: 'editable.ts', readOnly: false },
        { path: 'readonly.txt', readOnly: true },
        { path: 'editable2.ts', readOnly: false },
      ];

      mockFsReadFile
        .mockResolvedValueOnce(Buffer.from('readonly'))
        .mockResolvedValueOnce(Buffer.from('editable 1'))
        .mockResolvedValueOnce(Buffer.from('editable 2'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Each file gets its own assistant+tool result pair: 3 files * 2 messages = 6 messages
      expect(result.length).toBe(6);

      // Find all assistant messages with text content
      const assistantMessages = result.filter((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content) && (msg.content as any)[0].type === 'text');

      expect(assistantMessages.length).toBe(3);

      // First assistant message should be about read-only files
      const firstAssistantText = (assistantMessages[0].content as any)[0].text;
      expect(firstAssistantText).toContain('read-only');

      // Second and third assistant messages should be about editable files
      const secondAssistantText = (assistantMessages[1].content as any)[0].text;
      expect(secondAssistantText).toContain('can be edited');
      const thirdAssistantText = (assistantMessages[2].content as any)[0].text;
      expect(thirdAssistantText).toContain('can be edited');
    });

    it('should generate separate tool calls and results for each file group', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [
        { path: 'readonly.txt', readOnly: true },
        { path: 'editable.ts', readOnly: false },
      ];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('readonly content')).mockResolvedValueOnce(Buffer.from('editable content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // 2 files = 4 messages (2 assistant + 2 tool results)
      expect(result.length).toBe(4);

      // Count tool result messages (should be 2, one for each file)
      const toolResultMessages = result.filter((msg: any) => msg.role === 'tool');
      expect(toolResultMessages.length).toBe(2);

      // Verify each has unique tool call ID
      const toolCallIds = toolResultMessages.map((msg: any) => (msg.content as any)[0].toolCallId);
      expect(toolCallIds[0]).not.toBe(toolCallIds[1]);
    });

    it('should use different descriptions for read-only and editable sections', async () => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };

      const contextFiles: ContextFile[] = [
        { path: 'readonly.txt', readOnly: true },
        { path: 'editable.ts', readOnly: false },
      ];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('readonly')).mockResolvedValueOnce(Buffer.from('editable'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      const assistantMessages = result.filter((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content) && (msg.content as any)[0].type === 'text');

      const descriptions = assistantMessages.map((msg: any) => (msg.content as any)[0].text);

      // Should have two different descriptions
      expect(descriptions.some((desc: string) => desc.includes('read-only'))).toBe(true);
      expect(descriptions.some((desc: string) => desc.includes('can be edited'))).toBe(true);
    });
  });

  describe('Image Handling', () => {
    beforeEach(() => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };
    });

    it('should detect image files using isBinary and fileTypeFromBuffer', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

      mockIsBinary.mockReturnValue(true);
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });

      const contextFiles: ContextFile[] = [{ path: 'image.png', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(imageBuffer);

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      expect(mockIsBinary).toHaveBeenCalled();
      expect(mockFileTypeFromBuffer).toHaveBeenCalledWith(imageBuffer);

      // Should have user message with text part (filename only) and image part
      const imageUserMessage = result.find((msg: any) => msg.role === 'user' && Array.isArray(msg.content) && (msg.content as any)[0]?.type === 'text');
      expect(imageUserMessage).toBeDefined();
      expect((imageUserMessage!.content as any)[0].text).toContain('image.png');
      expect((imageUserMessage!.content as any)[1].type).toBe('image');
    });

    it('should return error in tool result for image files', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      mockIsBinary.mockReturnValue(true);
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });

      const contextFiles: ContextFile[] = [{ path: 'image.png', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(imageBuffer);

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Images don't generate tool-result messages - they use user message with text + image parts
      const toolResultMessage = result.find((msg: any) => msg.role === 'tool');
      expect(toolResultMessage).toBeUndefined();

      // Should have user message with text part (filename only) and image part
      const imageUserMessage = result.find((msg: any) => msg.role === 'user' && Array.isArray(msg.content) && (msg.content as any)[0]?.type === 'text');
      expect(imageUserMessage).toBeDefined();
      expect((imageUserMessage!.content as any)[0].text).toContain('image.png');
      expect((imageUserMessage!.content as any)[1].type).toBe('image');
    });

    it('should create user message with text and image parts for image file', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      mockIsBinary.mockReturnValue(true);
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });

      const contextFiles: ContextFile[] = [{ path: 'image.png', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(imageBuffer);

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Find user message with text part (filename only) followed by image part
      const imageUserMessage = result.filter((msg: any) => msg.role === 'user' && Array.isArray(msg.content) && msg.content[0]?.type === 'text');
      expect(imageUserMessage.length).toBe(1);
      // Text part should contain only the filename, not a full path
      expect((imageUserMessage[0].content as any)[0].text).toBe('Here is content of image file image.png');
      // Image part should follow
      expect((imageUserMessage[0].content as any)[1].type).toBe('image');
      expect((imageUserMessage[0].content as any)[1].image).toBe('iVBORw==');
    });

    it('should skip non-image binary files', async () => {
      const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);

      mockIsBinary.mockReturnValue(true);
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'application/octet-stream', ext: 'bin' });

      const contextFiles: ContextFile[] = [{ path: 'binary.bin', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(binaryBuffer);

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should have no messages since binary file was skipped
      expect(result.length).toBe(0);
    });

    it('should handle fileTypeFromBuffer errors gracefully', async () => {
      const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);

      mockIsBinary.mockReturnValue(true);
      mockFileTypeFromBuffer.mockRejectedValue(new Error('Detection failed'));

      const contextFiles: ContextFile[] = [{ path: 'unknown.bin', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(binaryBuffer);

      // Should not throw, just skip the file
      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      expect(result.length).toBe(0);
    });
  });

  describe('File Content Reading', () => {
    beforeEach(() => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };
    });

    it('should read file content correctly using fs.readFile', async () => {
      const expectedContent = 'Hello, World!';
      const contextFiles: ContextFile[] = [{ path: 'test.txt', readOnly: true }];

      // Implementation calls fs.readFile twice: once for binary detection, once in readFileContent
      mockFsReadFile.mockReset().mockResolvedValueOnce(Buffer.from(expectedContent)).mockResolvedValueOnce(Buffer.from(expectedContent));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      expect(mockFsReadFile).toHaveBeenCalled();

      // Verify content is in the tool result with line numbers
      const toolResultMessage = result.find((msg: any) => msg.role === 'tool');
      expect(toolResultMessage).toBeDefined();
      if (!toolResultMessage) {
        return;
      }
      // Content should have line numbers added by readFileContent(withLines: true)
      expect((toolResultMessage.content as any)[0].output.value).toContain('1|Hello, World!');
    });

    it('should convert absolute paths to relative paths', async () => {
      const contextFiles: ContextFile[] = [{ path: '/test/project/file.txt', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Find the assistant message with tool calls
      const assistantMessage = result.find((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content) && (msg.content as any)[0].type === 'text');

      // Find the tool-call part
      if (!assistantMessage) {
        return;
      }
      const toolCall = (assistantMessage.content as any).find((part: any) => part.type === 'tool-call');
      expect(toolCall).toBeDefined();

      // Verify the input uses relative path (from /test/project/file.txt to file.txt)
      expect(toolCall.input.filePath).toBe('file.txt');
    });

    it('should keep relative paths as-is', async () => {
      const contextFiles: ContextFile[] = [{ path: 'relative/path/file.txt', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      const assistantMessage = result.find((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content) && (msg.content as any)[0].type === 'text');
      expect(assistantMessage).toBeDefined();
      if (!assistantMessage) {
        return;
      }
      const toolCall = (assistantMessage.content as any).find((part: any) => part.type === 'tool-call');

      expect(toolCall.input.filePath).toBe('relative/path/file.txt');
    });

    it('should skip binary files that are not images', async () => {
      mockIsBinary.mockReturnValue(true);
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });

      const contextFiles: ContextFile[] = [{ path: 'document.pdf', readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('pdf content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should have no messages since binary file was skipped
      expect(result.length).toBe(0);
    });

    it('should handle fs.readFile errors gracefully', async () => {
      mockFsReadFile.mockRejectedValueOnce(new Error('File not found'));

      const contextFiles: ContextFile[] = [{ path: 'missing.txt', readOnly: true }];

      // Should not throw, just skip the file
      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Since file read failed, no tool messages should be created
      const toolMessages = result.filter((msg: any) => msg.role === 'tool');
      expect(toolMessages.length).toBe(0);
    });
  });

  describe('Rule Files Filtering', () => {
    beforeEach(() => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };
    });

    it('should filter out files in AIDER_DESK_PROJECT_RULES_DIR', async () => {
      const ruleFilePath = path.join(AIDER_DESK_PROJECT_RULES_DIR, 'rule1.md');
      const contextFiles: ContextFile[] = [
        { path: ruleFilePath, readOnly: true },
        { path: 'regular-file.txt', readOnly: true },
      ];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('regular content')).mockResolvedValueOnce(Buffer.from('rule content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should only have tool messages for the regular file, not the rule file
      const toolMessages = result.filter((msg: any) => msg.role === 'tool');
      expect(toolMessages.length).toBe(1);

      // Verify the tool call is for the regular file
      const assistantMessage = result.find((msg: any) => msg.role === 'assistant' && Array.isArray(msg.content));
      if (!assistantMessage) {
        return;
      }
      const toolCall = (assistantMessage.content as any).find((part: any) => part.type === 'tool-call');
      // toolCall.input is an object, not a JSON string
      const input = toolCall.input;
      expect(input.filePath).not.toContain('rule1.md');
    });

    it('should filter out files with AIDER_DESK_PROJECT_RULES_DIR as exact path', async () => {
      const contextFiles: ContextFile[] = [{ path: AIDER_DESK_PROJECT_RULES_DIR, readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should have no tool messages since the file was filtered out
      const toolMessages = result.filter((msg: any) => msg.role === 'tool');
      expect(toolMessages.length).toBe(0);
    });

    it('should handle rule files with different path separators', async () => {
      // Test with forward slash (Unix-style)
      const rulePathUnix = `${AIDER_DESK_PROJECT_RULES_DIR}/rule.md`;
      const contextFiles: ContextFile[] = [
        { path: rulePathUnix, readOnly: true },
        { path: 'normal.txt', readOnly: true },
      ];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('normal content')).mockResolvedValueOnce(Buffer.from('rule content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      const toolMessages = result.filter((msg: any) => msg.role === 'tool');
      expect(toolMessages.length).toBe(1);
    });

    it('should not filter files outside AIDER_DESK_PROJECT_RULES_DIR', async () => {
      const similarPath = path.join(AIDER_DESK_PROJECT_RULES_DIR + '-backup', 'file.md');
      const contextFiles: ContextFile[] = [{ path: similarPath, readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should have tool message for the file
      const toolMessages = result.filter((msg: any) => msg.role === 'tool');
      expect(toolMessages.length).toBe(1);
    });

    it('should normalize paths when filtering', async () => {
      // Path with '..' segments that resolves to the rules directory
      // Create a path like .aider-desk/rules/../aider-desk/rules/rule.md which normalizes to .aider-desk/rules/rule.md
      const rulePath = `${AIDER_DESK_PROJECT_RULES_DIR}${path.sep}..${path.sep}${path.basename(AIDER_DESK_PROJECT_RULES_DIR)}${path.sep}rule.md`;
      const contextFiles: ContextFile[] = [{ path: rulePath, readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // After normalization, this should be filtered out since it's in the rules directory
      const toolMessages = result.filter((msg: any) => msg.role === 'tool');
      expect(toolMessages.length).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      mockProfile.toolApprovals = {
        [fileReadToolId]: ToolApprovalState.Always,
      };
    });

    it('should return empty messages array when contextFiles is empty', async () => {
      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, []);

      expect(result).toEqual([]);
    });

    it('should return empty messages array when all files are filtered out', async () => {
      const contextFiles: ContextFile[] = [{ path: path.join(AIDER_DESK_PROJECT_RULES_DIR, 'rule.md'), readOnly: true }];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      expect(result).toEqual([]);
    });

    it('should return empty messages array when all file reads fail', async () => {
      const contextFiles: ContextFile[] = [
        { path: 'file1.txt', readOnly: true },
        { path: 'file2.txt', readOnly: true },
      ];

      // Reset any previous mock and set to reject
      mockFsReadFile.mockReset();
      mockFsReadFile.mockRejectedValue(new Error('Read error'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      // Should be empty since all reads failed (fileDataMap.size === 0)
      expect(result).toEqual([]);
    });

    it('should generate unique tool call IDs using uuid', async () => {
      const contextFiles: ContextFile[] = [
        { path: 'file1.txt', readOnly: true },
        { path: 'file2.txt', readOnly: false },
      ];

      mockFsReadFile.mockResolvedValueOnce(Buffer.from('content 1')).mockResolvedValueOnce(Buffer.from('content 2'));

      const result = await agent['getContextFilesAsToolCallMessages'](mockTask, mockProfile, contextFiles);

      const toolMessages = result.filter((msg: any) => msg.role === 'tool');
      const toolCallIds = toolMessages.map((msg: any) => msg.content[0].toolCallId);

      // Verify unique IDs were generated
      expect(new Set(toolCallIds).size).toBe(toolCallIds.length);
      expect(mockUuidv4).toHaveBeenCalled();
    });
  });
});

describe('Agent - prepareMessages sanitisation', () => {
  let agent: Agent;
  let mockTask: ReturnType<typeof createMockTask>;
  let mockProfile: ReturnType<typeof createMockAgentProfile>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockTask = createMockTask();
    mockProfile = createMockAgentProfile({
      includeRepoMappings: false,
      includeContextFiles: false,
    });

    const mockStore = { getSettings: vi.fn(() => ({})) };
    const mockAgentProfileManager = { getProjectProfiles: vi.fn(() => []) };
    const mockMcpManager = { getConnectors: vi.fn(() => []) };
    const mockMcpConfigManager = { getMergedServers: vi.fn(() => ({})) };
    const mockModelManager = {
      createLlm: vi.fn(),
      getProviderOptions: vi.fn(() => ({})),
      getProviderParameters: vi.fn(() => ({})),
      getCacheControl: vi.fn(() => ({})),
      getModelSettings: vi.fn(() => undefined),
      getProviderTools: vi.fn(() => Promise.resolve({})),
      isStreamingDisabled: vi.fn(() => false),
      isToolCallStreamingDisabled: vi.fn(() => false),
    };
    const mockTelemetryManager = { captureAgentRun: vi.fn() };
    const mockMemoryManager = {};
    const mockPromptsManager = {};
    const mockExtensionManager = {
      isInitialized: vi.fn(() => false),
      createExtensionToolset: vi.fn(() => ({})),
    };

    agent = new AgentClass(
      mockStore as any,
      mockAgentProfileManager as any,
      mockMcpManager as any,
      mockMcpConfigManager as any,
      mockModelManager as any,
      mockTelemetryManager as any,
      mockMemoryManager as any,
      mockPromptsManager as any,
      mockExtensionManager as any,
    );
  });

  it('strips providerOptions when target model differs from message model', async () => {
    const history: ContextAssistantMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openrouter/model-a',
        content: [makeTextPart('hello', { openai: { itemId: 'rs_1' } })],
        providerOptions: { openai: { batchId: 'b1' } },
      } as ContextAssistantMessage,
    ];

    const result = await agent['prepareMessages'](mockTask, mockProfile, history, [], 'openrouter/model-b');
    const r = result[0] as any;
    expect(r.providerOptions).toBeUndefined();
    expect(r.content[0].providerOptions).toBeUndefined();
    expect(r.content[0].text).toBe('hello');
  });

  it('preserves providerOptions when target model matches message model', async () => {
    const history: ContextAssistantMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openrouter/model-a',
        content: [makeTextPart('hello', { openai: { itemId: 'rs_1' } })],
        providerOptions: { openai: { batchId: 'b1' } },
      } as ContextAssistantMessage,
    ];

    const result = await agent['prepareMessages'](mockTask, mockProfile, history, [], 'openrouter/model-a');
    const r = result[0] as any;
    expect(r.providerOptions).toBeDefined();
    expect(r.content[0].providerOptions).toBeDefined();
  });

  it('returns input unchanged when no targetModelId is provided', async () => {
    const history: ContextAssistantMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: [makeTextPart('hello')],
      } as ContextAssistantMessage,
    ];

    const result = await agent['prepareMessages'](mockTask, mockProfile, history, []);
    expect(result[0]).toBe(history[0] as any);
  });

  it('does not mutate the input history array', async () => {
    const history: ContextAssistantMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openrouter/model-a',
        content: [makeTextPart('hello', { openai: { itemId: 'rs_1' } })],
        providerOptions: { openai: { batchId: 'b1' } },
      } as ContextAssistantMessage,
    ];

    await agent['prepareMessages'](mockTask, mockProfile, history, [], 'openrouter/model-b');
    expect((history[0] as any).providerOptions).toBeDefined();
    expect((history[0].content[0] as any).providerOptions).toBeDefined();
  });

  it('prepends repository mappings before ordinary context files', async () => {
    mockProfile.includeContextFiles = true;
    mockProfile.includeRepoMappings = true;
    mockProfile.toolApprovals = {
      [fileReadToolId]: ToolApprovalState.Always,
    };
    mockTask.getRepositoryMappingFiles = vi.fn().mockResolvedValue([{ path: '.aider-desk/mappings/map.md', readOnly: true, source: 'repo-mapping' }]);
    mockTask.resolveContextFilePath = vi.fn((filePath: string) => Promise.resolve(`/test/project/${filePath}`));
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('mapping content') as any);

    const messages = await agent['prepareMessages'](
      mockTask,
      mockProfile,
      [],
      [{ path: 'src/app.ts', readOnly: false }],
      'test-provider/test-model',
    );

    const mappingToolCallIndex = messages.findIndex(
      (message: any) => message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part: any) => part.input?.filePath === '.aider-desk/mappings/map.md'),
    );
    const contextToolCallIndex = messages.findIndex(
      (message: any) => message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part: any) => part.input?.filePath === 'src/app.ts'),
    );

    expect(mappingToolCallIndex).toBeGreaterThanOrEqual(0);
    expect(contextToolCallIndex).toBeGreaterThan(mappingToolCallIndex);
  });

  it('injects mapping content when includeContextFiles is disabled', async () => {
    mockProfile.includeContextFiles = false;
    mockProfile.includeRepoMappings = true;
    mockProfile.toolApprovals = {
      [fileReadToolId]: ToolApprovalState.Always,
    };
    mockTask.getRepositoryMappingFiles = vi.fn().mockResolvedValue([{ path: '.aider-desk/mappings/map.md', readOnly: true, source: 'repo-mapping' }]);
    mockTask.resolveContextFilePath = vi.fn((filePath: string) => Promise.resolve(`/test/project/${filePath}`));
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('mapping content') as any);

    const messages = await agent['prepareMessages'](
      mockTask,
      mockProfile,
      [],
      [{ path: 'src/app.ts', readOnly: false }],
      'test-provider/test-model',
    );

    // 1. Mapping content is inlined (tool-call followed by tool-result with content).
    const mappingToolCallIndex = messages.findIndex(
      (message: any) => message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part: any) => part.input?.filePath === '.aider-desk/mappings/map.md'),
    );
    expect(mappingToolCallIndex).toBeGreaterThanOrEqual(0);
    const mappingToolResult = messages.find(
      (message: any) => message.role === 'tool' && Array.isArray(message.content) && message.content.some((part: any) => part.type === 'tool-result' && String(part.output).includes('mapping content')),
    );
    expect(mappingToolResult).toBeDefined();

    // 2. The ordinary context file remains a working-files listing.
    const workingFilesMessage = messages.find(
      (message: any) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('currently in the working context') && message.content.includes('src/app.ts'),
    );
    expect(workingFilesMessage).toBeDefined();

    // 3. Mappings are injected before the working-files listing.
    const workingFilesIndex = messages.indexOf(workingFilesMessage);
    expect(mappingToolCallIndex).toBeLessThan(workingFilesIndex);
  });
});

describe('Agent - runAgent lifecycle persistence', () => {
  let agent: Agent;
  let mockTask: any;
  let mockProfile: ReturnType<typeof createMockAgentProfile>;
  let mockExtensionManager: any;
  let persistenceLog: string[];

  const provider = {
    id: 'test-provider',
    provider: { name: 'test-provider' },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    persistenceLog = [];
    let flushCount = 0;

    mockTask = createMockTask();
    mockTask.getContextMessages = vi.fn(() => Promise.resolve([]));
    mockTask.getContextFiles = vi.fn(() => Promise.resolve([]));
    mockTask.addContextMessage = vi.fn(async (message: ContextMessage) => {
      persistenceLog.push(`add:${message.role}`);
    });
    mockTask.flushContext = vi.fn(async () => {
      flushCount++;
      persistenceLog.push(`flush:${flushCount}`);
    });
    mockTask.addLogMessage = vi.fn();
    mockTask.processResponseMessage = vi.fn(() => Promise.resolve());
    mockTask.addToolMessage = vi.fn();
    mockTask.updateTask = vi.fn(() => Promise.resolve());
    mockTask.createSkillMessages = vi.fn(() => Promise.resolve(null));

    mockProfile = createMockAgentProfile({
      useAiderTools: false,
      usePowerTools: false,
      useSubagents: false,
      useTodoTools: false,
      useTaskTools: false,
      useMemoryTools: false,
      useSkillsTools: false,
      includeContextFiles: false,
      includeRepoMappings: false,
      autoCompactThresholdPercentage: 0,
      autoCompactThresholdTokens: 0,
      autoCompactionType: ContextCompactionType.Compact,
      maxIterations: 10,
    });

    const mockStore = {
      getSettings: vi.fn(() => ({})),
      getUserId: vi.fn(() => 'test-user'),
    };
    const mockAgentProfileManager = { getProjectProfiles: vi.fn(() => []) };
    const mockMcpManager = {
      getConnectors: vi.fn(() => []),
      createToolset: vi.fn(() => Promise.resolve({})),
    };
    const mockMcpConfigManager = { getMergedServers: vi.fn(() => ({})) };
    const mockModelManager = {
      getProviders: vi.fn(() => [provider]),
      createLlm: vi.fn(() => Promise.resolve({ modelId: 'test-model' })),
      getProviderOptions: vi.fn(() => ({})),
      getProviderParameters: vi.fn(() => ({})),
      getCacheControl: vi.fn(() => undefined),
      getModelSettings: vi.fn(() => undefined),
      getProviderTools: vi.fn(() => Promise.resolve({})),
      isStreamingDisabled: vi.fn(() => false),
      isToolCallStreamingDisabled: vi.fn(() => false),
      normalizeMessages: vi.fn((_p: any, _m: any, messages: any) => messages),
      getUsageReport: vi.fn(() => undefined),
      isRetryable: vi.fn(() => false),
    };
    const mockTelemetryManager = { captureAgentRun: vi.fn() };
    const mockMemoryManager = {};
    const mockPromptsManager = { getSystemPrompt: vi.fn(() => Promise.resolve('system prompt')) };
    mockExtensionManager = {
      isInitialized: vi.fn(() => false),
      createExtensionToolset: vi.fn(() => ({})),
      dispatchEvent: vi.fn(async (event: string, data: any) => {
        if (event === 'onAgentStarted') {
          return { ...data };
        }
        if (event === 'onAgentStepFinished') {
          return { responseMessages: data.responseMessages, finishReason: data.finishReason };
        }
        if (event === 'onAgentFinished') {
          return { resultMessages: data.resultMessages };
        }
        return {};
      }),
    };

    agent = new AgentClass(
      mockStore as any,
      mockAgentProfileManager as any,
      mockMcpManager as any,
      mockMcpConfigManager as any,
      mockModelManager as any,
      mockTelemetryManager as any,
      mockMemoryManager as any,
      mockPromptsManager as any,
      mockExtensionManager as any,
    );

    let uuidCounter = 1;
    vi.mocked(uuidv4).mockImplementation(() => `uuid-${uuidCounter++}` as any);
  });

  /**
   * Builds a deterministic fake AI SDK step result. The `response.messages`
   * array is what `processStep` turns into persisted context messages.
   */
  function makeStepResult(overrides: any = {}) {
    return {
      finishReason: 'stop',
      rawFinishReason: 'stop',
      content: [{ type: 'text', text: 'Hello from assistant' }],
      text: 'Hello from assistant',
      reasoningText: undefined,
      toolCalls: [],
      toolResults: [],
      usage: undefined,
      providerMetadata: undefined,
      response: {
        messages: [{ role: 'assistant', content: 'Hello from assistant' }],
      },
      ...overrides,
    };
  }

  /**
   * Installs a single-step `streamText` mock. `onStepEnd` is invoked with the
   * fake step result and awaited inside the stream so persistence completes
   * before the run resolves, mirroring the real SDK's step lifecycle.
   */
  function mockSingleStepStream(stepResult: any) {
    mockStreamText.mockImplementation((options: any) => {
      persistenceLog.push('model-execution');
      const stepEndPromise = options.onStepEnd(stepResult);
      return {
        stream: (async function* () {
          yield { type: 'text-start' };
          yield { type: 'text-delta', text: 'Hello' };
          await stepEndPromise;
          yield { type: 'text-end' };
        })(),
      };
    });
  }

  it('persists and flushes the initial user request before model execution when includeInContext is true', async () => {
    const prompt = 'Implement the feature';
    const promptContext = { id: 'pc-1' };

    mockSingleStepStream(makeStepResult());

    const result = await agent.runAgent(mockTask, mockProfile, prompt, 'agent', promptContext);

    // The initial user request is passed to addContextMessage
    expect(mockTask.addContextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pc-1', role: 'user', content: prompt }),
    );

    // The user request is persisted and flushed before any model execution begins
    expect(persistenceLog[0]).toBe('add:user');
    expect(persistenceLog[1]).toBe('flush:1');
    expect(persistenceLog.indexOf('model-execution')).toBeGreaterThan(persistenceLog.indexOf('flush:1'));

    // The user request is also returned to the caller
    expect(result.some((m: ContextMessage) => m.role === 'user' && m.content === prompt)).toBe(true);
  });

  it('appends and flushes the completed assistant step before the run resolves', async () => {
    mockSingleStepStream(makeStepResult());

    const result = await agent.runAgent(mockTask, mockProfile, 'Do it', 'agent', { id: 'pc-1' });

    const assistantMessage = result.find((m: ContextMessage) => m.role === 'assistant');
    expect(assistantMessage).toBeDefined();

    // The completed step message is appended to the task context and flushed
    expect(mockTask.addContextMessage).toHaveBeenCalledWith(assistantMessage);
    expect(mockTask.flushContext).toHaveBeenCalledTimes(2);

    // Deterministic persistence order: user add -> user flush -> model execution -> step add -> step flush
    expect(persistenceLog).toEqual(['add:user', 'flush:1', 'model-execution', 'add:assistant', 'flush:2']);
  });

  it('persists one completed assistant message exactly once and returns it exactly once', async () => {
    mockSingleStepStream(makeStepResult());

    const result = await agent.runAgent(mockTask, mockProfile, 'Do it', 'agent', { id: 'pc-1' });

    const assistantMessages = result.filter((m: ContextMessage) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);

    const persistedAssistant = mockTask.addContextMessage.mock.calls
      .map(([message]: [ContextMessage]) => message)
      .filter((message: ContextMessage) => message.role === 'assistant');
    expect(persistedAssistant).toHaveLength(1);
    // The exact same message object is persisted and returned
    expect(persistedAssistant[0]).toBe(assistantMessages[0]);
  });

  it('flushes a completed tool-call step before a subsequent iteration begins', async () => {
    const firstStep = makeStepResult({
      finishReason: 'tool-calls',
      rawFinishReason: 'tool-calls',
      content: [{ type: 'text', text: 'First step' }],
      text: 'First step',
      response: { messages: [{ role: 'assistant', content: 'First step' }] },
    });
    const secondStep = makeStepResult();

    mockStreamText
      .mockImplementationOnce((options: any) => {
        persistenceLog.push('model-execution');
        const stepEndPromise = options.onStepEnd(firstStep);
        return { stream: (async function* () { await stepEndPromise; })() };
      })
      .mockImplementationOnce((options: any) => {
        persistenceLog.push('model-execution');
        const stepEndPromise = options.onStepEnd(secondStep);
        return { stream: (async function* () { await stepEndPromise; })() };
      });

    const result = await agent.runAgent(mockTask, mockProfile, 'Do it', 'agent', { id: 'pc-1' });

    const assistantMessages = result.filter((m: ContextMessage) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].content).toBe('First step');
    expect(assistantMessages[1].content).toBe('Hello from assistant');

    // The first step's flush happens before the second model execution begins
    const firstStepFlushIndex = persistenceLog.indexOf('flush:2');
    const secondModelExecutionIndex = persistenceLog.lastIndexOf('model-execution');
    expect(firstStepFlushIndex).toBeGreaterThanOrEqual(0);
    expect(firstStepFlushIndex).toBeLessThan(secondModelExecutionIndex);
  });

  it('persists and accumulates only extension-replaced step messages, not the originals', async () => {
    const replacementMessage = { role: 'assistant', content: 'Replacement response' };

    mockExtensionManager.dispatchEvent.mockImplementation(async (event: string, data: any) => {
      if (event === 'onAgentStarted') {
        return { ...data };
      }
      if (event === 'onAgentStepFinished') {
        return { responseMessages: [replacementMessage], finishReason: data.finishReason };
      }
      if (event === 'onAgentFinished') {
        return { resultMessages: data.resultMessages };
      }
      return {};
    });

    mockSingleStepStream(makeStepResult());

    const result = await agent.runAgent(mockTask, mockProfile, 'Do it', 'agent', { id: 'pc-1' });

    const persisted = mockTask.addContextMessage.mock.calls.map(([message]: [ContextMessage]) => message);
    // The original step message produced by processStep is neither persisted nor accumulated
    expect(persisted.some((m: ContextMessage) => m.role === 'assistant' && m.content === 'Hello from assistant')).toBe(false);
    expect(result.some((m: ContextMessage) => m.role === 'assistant' && m.content === 'Hello from assistant')).toBe(false);

    // Only the replacement message is persisted and accumulated
    expect(persisted.some((m: ContextMessage) => m.role === 'assistant' && m.content === 'Replacement response')).toBe(true);
    const assistantMessages = result.filter((m: ContextMessage) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toBe('Replacement response');
  });

  it('does not persist or accumulate helper-only tool-call/result messages', async () => {
    const helperToolName = 'helpers---no_such_tool';
    const helperToolCallId = 'tc-helper-1';

    const helperStep = makeStepResult({
      finishReason: 'tool-calls',
      rawFinishReason: 'tool-calls',
      content: [{ type: 'tool-call', toolCallId: helperToolCallId, toolName: helperToolName, input: { toolName: 'x', availableTools: [] } }],
      toolCalls: [{ toolCallId: helperToolCallId, toolName: helperToolName, input: { toolName: 'x', availableTools: [] } }],
      toolResults: [{ toolCallId: helperToolCallId, toolName: helperToolName, input: { toolName: 'x', availableTools: [] }, output: 'Error: no such tool' }],
      response: {
        messages: [
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: helperToolCallId, toolName: helperToolName, input: { toolName: 'x', availableTools: [] } }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: helperToolCallId, toolName: helperToolName, output: 'Error: no such tool' }] },
        ],
      },
    });
    const finalStep = makeStepResult();

    mockStreamText
      .mockImplementationOnce((options: any) => {
        const stepEndPromise = options.onStepEnd(helperStep);
        return { stream: (async function* () { await stepEndPromise; })() };
      })
      .mockImplementationOnce((options: any) => {
        const stepEndPromise = options.onStepEnd(finalStep);
        return { stream: (async function* () { await stepEndPromise; })() };
      });

    const result = await agent.runAgent(mockTask, mockProfile, 'Do it', 'agent', { id: 'pc-1' });

    const persisted = mockTask.addContextMessage.mock.calls.map(([message]: [ContextMessage]) => message);
    const isHelperMessage = (m: ContextMessage) =>
      m.role === 'tool' ||
      (m.role === 'assistant' && Array.isArray(m.content) && (m.content as any[]).some((p: any) => p.type === 'tool-call' && p.toolName === helperToolName));

    // Helper-only messages are neither persisted nor accumulated
    expect(persisted.some(isHelperMessage)).toBe(false);
    expect(result.some(isHelperMessage)).toBe(false);

    // Only the user request and the final non-helper assistant message are persisted
    expect(persisted).toHaveLength(2);
    expect(mockTask.flushContext).toHaveBeenCalledTimes(2);
    expect(result.filter((m: ContextMessage) => m.role === 'assistant')).toHaveLength(1);
  });

  it('keeps filterResultMessages dropping helper-only messages while preserving normal ones', () => {
    const helperToolName = 'helpers---no_such_tool';
    const helperAssistant = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: helperToolName, input: {} }] };
    const helperTool = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc-1', toolName: helperToolName, output: 'Error' }] };
    const normalAssistant = { role: 'assistant', content: 'Normal response' };

    const filtered = agent['filterResultMessages']([helperAssistant, helperTool, normalAssistant] as ContextMessage[]);

    expect(filtered).toEqual([normalAssistant]);
  });

  it('does not append or flush context for completed steps when includeInContext is false', async () => {
    mockSingleStepStream(makeStepResult());

    const result = await agent.runAgent(mockTask, mockProfile, 'Do it', 'agent', { id: 'pc-1' }, undefined, undefined, undefined, false);

    // No context append or flush is performed at all
    expect(mockTask.addContextMessage).not.toHaveBeenCalled();
    expect(mockTask.flushContext).not.toHaveBeenCalled();

    // Returned messages remain available to the caller
    expect(result.some((m: ContextMessage) => m.role === 'user' && m.content === 'Do it')).toBe(true);
    expect(result.some((m: ContextMessage) => m.role === 'assistant' && m.content === 'Hello from assistant')).toBe(true);
  });

  it('surfaces a flushContext rejection and does not treat the step as durable', async () => {
    // First flush (user request) succeeds; the step flush fails
    mockTask.flushContext.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('flush failed'));

    mockSingleStepStream(makeStepResult());

    const result = await agent.runAgent(mockTask, mockProfile, 'Do it', 'agent', { id: 'pc-1' });

    // The error is surfaced, not swallowed
    expect(mockTask.addLogMessage).toHaveBeenCalledWith('error', 'flush failed', false, expect.anything());
    // The run is marked interrupted rather than completing successfully
    expect(mockTask.updateTask).toHaveBeenCalledWith({ state: DefaultTaskState.Interrupted });
    // The failed step is not treated as durable: it is not accumulated in resultMessages
    expect(result.some((m: ContextMessage) => m.role === 'assistant')).toBe(false);
    // No further model execution happens after the failed flush
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });
});

/**
 * Helper to create a text part with optional providerOptions for test fixtures.
 */
function makeTextPart(text: string, providerOptions?: Record<string, unknown>) {
  return {
    type: 'text' as const,
    text,
    ...(providerOptions ? { providerOptions } : {}),
  };
}

describe('Agent - compactMessagesIfNeeded', () => {
  let agent: Agent;
  let mockProfile: ReturnType<typeof createMockAgentProfile>;

  const buildAgent = (getModelSettings: () => unknown, percentage = 90) => {
    const mockStore = {
      getSettings: vi.fn(() => ({
        taskSettings: {
          contextCompactingThreshold: { percentage, tokens: 100000 },
          contextCompactionType: ContextCompactionType.Compact,
        },
      })),
    };
    const mockModelManager = {
      getModelSettings: vi.fn(getModelSettings),
    };

    return new AgentClass(
      mockStore as any,
      {} as any,
      { getConnectors: vi.fn(() => []) } as any,
      { getMergedServers: vi.fn(() => ({})) } as any,
      mockModelManager as any,
      { captureAgentRun: vi.fn() } as any,
      {} as any,
      {} as any,
      { isInitialized: vi.fn(() => false), createExtensionToolset: vi.fn(() => ({})) } as any,
    );
  };

  const makeUserRequestMessage = (): any => ({
    id: 'user-1',
    role: 'user',
    content: 'continue',
  });

  const makeResultMessages = (sentTokens: number): any[] => [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      usageReport: {
        model: 'test-model',
        sentTokens,
        receivedTokens: 1000,
        cacheReadTokens: 0,
        messageCost: 0,
        agentTotalCost: 0,
      },
    },
  ];

  const runCompact = async (resultMessages: any[]) => {
    const task = createMockTask();
    task.compactConversation = vi.fn().mockResolvedValue(undefined);
    task.smartCompactConversation = vi.fn().mockResolvedValue([]);
    task.handoffConversation = vi.fn().mockResolvedValue(undefined);
    task.getContextMessages = vi.fn().mockResolvedValue([]);
    task.addLogMessage = vi.fn();
    task.reloadGroupMessages = vi.fn();

    agent['prepareMessages'] = vi.fn().mockResolvedValue([]);

    await agent['compactMessagesIfNeeded'](
      task,
      mockProfile,
      { id: 'test-provider' } as any,
      'test-model',
      makeUserRequestMessage(),
      [],
      [],
      [],
      resultMessages,
    );

    return task;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile = createMockAgentProfile();
  });

  it('should compact based on the token threshold when the model context size is unknown', async () => {
    // maxInputTokens is undefined (custom/self-hosted model not in the catalog)
    agent = buildAgent(() => undefined);

    // 120000 + 1000 = 121000 > 100000 token threshold
    const task = await runCompact(makeResultMessages(120000));

    expect(task.compactConversation).toHaveBeenCalledTimes(1);
  });

  it('should NOT compact when token usage is below the token threshold and context size is unknown', async () => {
    agent = buildAgent(() => undefined);

    // 50000 + 1000 = 51000 < 100000 token threshold
    const task = await runCompact(makeResultMessages(50000));

    expect(task.compactConversation).not.toHaveBeenCalled();
  });

  it('should use the task-level token override even when the model context size is unknown', async () => {
    agent = buildAgent(() => undefined);

    // Set a low task-level override so that 121000 tokens exceeds it
    const task = createMockTask({ contextCompactingThresholdTokens: 50000 } as any);
    task.compactConversation = vi.fn().mockResolvedValue(undefined);
    task.getContextMessages = vi.fn().mockResolvedValue([]);
    task.addLogMessage = vi.fn();
    task.reloadGroupMessages = vi.fn();
    agent['prepareMessages'] = vi.fn().mockResolvedValue([]);

    await agent['compactMessagesIfNeeded'](
      task,
      mockProfile,
      { id: 'test-provider' } as any,
      'test-model',
      makeUserRequestMessage(),
      [],
      [],
      [],
      makeResultMessages(120000),
    );

    expect(task.compactConversation).toHaveBeenCalledTimes(1);
  });

  it('should honor the percentage threshold when the model context size is known', async () => {
    // maxInputTokens known: 200000. percentage 90 -> 180000, tokens 100000 -> min = 100000
    agent = buildAgent(() => ({ id: 'test-model', providerId: 'test-provider', maxInputTokens: 200000 }));

    // 121000 > 100000
    const task = await runCompact(makeResultMessages(120000));

    expect(task.compactConversation).toHaveBeenCalledTimes(1);
  });

  it('should not compact when percentage is 0 (explicit disable) with a known context size', async () => {
    agent = buildAgent(() => ({ id: 'test-model', providerId: 'test-provider', maxInputTokens: 200000 }), 0);

    const task = await runCompact(makeResultMessages(120000));

    expect(task.compactConversation).not.toHaveBeenCalled();
  });

  it('should not compact when percentage is 0 (explicit disable) even with an unknown context size', async () => {
    agent = buildAgent(() => undefined, 0);

    const task = await runCompact(makeResultMessages(120000));

    expect(task.compactConversation).not.toHaveBeenCalled();
  });

  it('should count a tool result appended after the last usage report when measuring context size', async () => {
    agent = buildAgent(() => ({ id: 'test-model', providerId: 'test-provider', maxInputTokens: 200000 }));

    // The usage report alone (51000) is below the 100000 threshold, but the large
    // trailing tool result must push the measured total past it.
    const bigText = 'lorem ipsum dolor sit amet '.repeat(10000); // ~70k tokens
    const resultMessages = [
      ...makeResultMessages(50000),
      {
        id: 'tool-1',
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'power:file_read', output: { type: 'text', value: bigText } }],
      },
    ];

    const task = await runCompact(resultMessages);

    expect(task.compactConversation).toHaveBeenCalledTimes(1);
  });

  it('should not compact when the trailing tool result keeps the total below the threshold', async () => {
    agent = buildAgent(() => ({ id: 'test-model', providerId: 'test-provider', maxInputTokens: 200000 }));

    const resultMessages = [
      ...makeResultMessages(50000),
      {
        id: 'tool-1',
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'power:file_read', output: { type: 'text', value: 'ok' } }],
      },
    ];

    const task = await runCompact(resultMessages);

    expect(task.compactConversation).not.toHaveBeenCalled();
  });
});
