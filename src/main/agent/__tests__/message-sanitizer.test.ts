/**
 * Tests for message-sanitizer.ts
 *
 * Covers the following cases:
 * 1. Same model → untouched (reference equality)
 * 2. Different model → payloads stripped
 * 3. Unknown provenance → treated as different and sanitised
 * 4. usageReport.model fallback
 * 5. Empty reasoning part dropped
 * 6. Assistant message dropped when it becomes empty; not dropped with tool-call
 * 7. Tool messages never dropped, never lose parts
 * 8. User/system messages returned by reference
 * 9. Input is not mutated
 * 10. Invariant: tool-call ids == tool-result ids before and after
 */

import { describe, expect, it, vi } from 'vitest';
import { sanitizeMessagesForModel, getMessageSourceModelId } from '../message-sanitizer';
import type { ContextMessage, ContextAssistantMessage, ContextToolMessage } from '@common/types/context';
import type { ModelMessage } from 'ai';

// Mock logger
vi.mock('@/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Fixture helpers ──────────────────────────────────────────────────────

const makeTextPart = (text: string, providerOptions?: Record<string, unknown>) => ({
  type: 'text' as const,
  text,
  ...(providerOptions ? { providerOptions } : {}),
});

const makeReasoningPart = (text: string, providerOptions?: Record<string, unknown>) => ({
  type: 'reasoning' as const,
  text,
  ...(providerOptions ? { providerOptions } : {}),
});

const makeToolCallPart = (toolCallId: string, toolName: string, input: unknown, providerOptions?: Record<string, unknown>) => ({
  type: 'tool-call' as const,
  toolCallId,
  toolName,
  input,
  ...(providerOptions ? { providerOptions } : {}),
});

const makeToolResultPart = (toolCallId: string, toolName: string, output: { type: string; value: unknown }, providerOptions?: Record<string, unknown>) => ({
  type: 'tool-result' as const,
  toolCallId,
  toolName,
  output,
  ...(providerOptions ? { providerOptions } : {}),
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('getMessageSourceModelId', () => {
  it('returns model when present', () => {
    const msg = { model: 'openai/gpt-4' } as ContextAssistantMessage;
    expect(getMessageSourceModelId(msg)).toBe('openai/gpt-4');
  });

  it('falls back to usageReport.model', () => {
    const msg = { usageReport: { model: 'anthropic/claude-3' } } as ContextAssistantMessage;
    expect(getMessageSourceModelId(msg)).toBe('anthropic/claude-3');
  });

  it('returns undefined when neither is available', () => {
    const msg = {} as ContextAssistantMessage;
    expect(getMessageSourceModelId(msg)).toBeUndefined();
  });

  it('returns undefined for user/tool messages without model', () => {
    const msg = { role: 'user' } as ContextMessage;
    expect(getMessageSourceModelId(msg)).toBeUndefined();
  });
});

describe('sanitizeMessagesForModel', () => {
  // ── Case 1: Same model → untouched ──────────────────────────────────────
  it('returns the same reference when message model matches target', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openrouter/model-a',
        content: [
          makeReasoningPart('thinking', { openrouter: { reasoningDetails: [{ type: 'reasoning.encrypted', data: 'X' }] } }),
          makeTextPart('hello'),
        ],
        providerOptions: { openrouter: { something: true } },
      } as ContextAssistantMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'openrouter/model-a');
    expect(result[0]).toBe(msgs[0]); // Same reference
  });

  // ── Case 2: Different model → payloads stripped ─────────────────────────
  it('strips providerOptions from messages and parts when model differs', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openrouter/model-a',
        content: [
          makeReasoningPart('thinking', { openai: { itemId: 'rs_1' } }),
          makeToolCallPart('tc1', 'test_tool', { foo: 'bar' }, { google: { thoughtSignature: 'TS' } }),
          makeToolResultPart('tc1', 'test_tool', { type: 'text', value: 'result' }, { anthropic: { signature: 'SIG' } }),
        ],
        providerOptions: { openrouter: { batchId: 'b1' } },
      } as ContextAssistantMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'openrouter/model-b');

    expect(result[0]).not.toBe(msgs[0]); // Different object

    const r = result[0] as ContextAssistantMessage;

    // Message-level providerOptions removed
    expect((r as any).providerOptions).toBeUndefined();

    // Each part's providerOptions removed
    expect((r.content as any[]).every((p: any) => p.providerOptions === undefined)).toBe(true);

    // Text preserved
    const reasoningPart = (r.content as any[]).find((p: any) => p.type === 'reasoning');
    expect(reasoningPart.text).toBe('thinking');

    // Tool-call preserved
    const tcPart = (r.content as any[]).find((p: any) => p.type === 'tool-call');
    expect(tcPart.toolCallId).toBe('tc1');
    expect(tcPart.toolName).toBe('test_tool');
    expect(tcPart.input).toEqual({ foo: 'bar' });

    // Tool-result preserved
    const trPart = (r.content as any[]).find((p: any) => p.type === 'tool-result');
    expect(trPart.toolCallId).toBe('tc1');
    expect(trPart.output).toEqual({ type: 'text', value: 'result' });
  });

  // ── Case 3: Unknown provenance → sanitised ─────────────────────────────
  it('treats messages without model/usageReport as foreign and sanitises them', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: [makeTextPart('legacy', { openai: { itemId: 'old' } })],
        providerOptions: { openai: { batchId: 'b1' } },
      } as ContextAssistantMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'any-model');

    const r = result[0] as ContextAssistantMessage;
    expect((r as any).providerOptions).toBeUndefined();
    expect((r.content as any[])[0].providerOptions).toBeUndefined();
    expect((r.content as any[])[0].text).toBe('legacy');
  });

  // ── Case 4: usageReport.model fallback ─────────────────────────────────
  it('uses usageReport.model to determine provenance when model is absent', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: [makeTextPart('match via usage')],
        usageReport: { model: 'openai/gpt-4', sentTokens: 0, receivedTokens: 0, messageCost: 0 },
        providerOptions: { openai: { itemId: 'rs_1' } },
      } as ContextAssistantMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'openai/gpt-4');
    expect(result[0]).toBe(msgs[0]); // Same reference, untouched
  });

  // ── Case 5: Empty reasoning part dropped ───────────────────────────────
  it('drops empty reasoning parts (encrypted-only) while retaining text parts', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openai/gpt-4',
        content: [
          makeReasoningPart('', { openai: { reasoningEncryptedContent: 'ENC', itemId: 'rs_1' } }),
          makeTextPart('real response'),
          makeReasoningPart('partial', { openai: { itemId: 'rs_2' } }),
        ],
      } as ContextAssistantMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'anthropic/claude'); // different model triggers sanitisation

    const r = result[0] as ContextAssistantMessage;
    const parts = r.content as any[];
    expect(parts.length).toBe(2); // encrypted-only reasoning dropped
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toBe('real response');
    expect(parts[1].type).toBe('reasoning');
    expect(parts[1].text).toBe('partial');
  });

  // ── Case 6: Assistant dropped when empty, not dropped with tool-call ────
  it('drops an assistant message that becomes completely empty after sanitisation', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openai/gpt-4',
        content: [makeReasoningPart('', { openai: { itemId: 'rs_1' } })],
      } as ContextAssistantMessage,
      {
        id: '2',
        role: 'user',
        content: 'hello',
      } as ContextMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'anthropic/claude');
    expect(result.length).toBe(1);
    expect(result[0].role).toBe('user');
  });

  it('does NOT drop an assistant message if it still contains a tool-call part', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openai/gpt-4',
        content: [
          makeReasoningPart('', { openai: { itemId: 'rs_1' } }),
          makeToolCallPart('tc1', 'read', { filePath: '/tmp/x' }),
        ],
      } as ContextAssistantMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'anthropic/claude');
    expect(result.length).toBe(1);
    const r = result[0] as ContextAssistantMessage;
    const parts = r.content as any[];
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('tool-call');
    expect(parts[0].toolCallId).toBe('tc1');
  });

  // ── Case 7: Tool messages never dropped ─────────────────────────────────
  it('never drops tool messages; only strips providerOptions', () => {
    const msgs: ContextToolMessage[] = [
      {
        id: '1',
        role: 'tool',
        content: [
          makeToolResultPart('tc1', 'read', { type: 'text', value: 'ok' }, { anthropic: { signature: 'SIG' } }),
        ],
        providerOptions: { anthropic: { batchId: 'b1' } },
      } as ContextToolMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'other-model');
    expect(result.length).toBe(1);
    const r = result[0] as ContextToolMessage;
    expect((r as any).providerOptions).toBeUndefined();
    expect(r.content.length).toBe(1);
    expect((r.content[0] as any).providerOptions).toBeUndefined();
    expect((r.content[0] as any).toolCallId).toBe('tc1');
  });

  // ── Case 8: User/system messages returned by reference ──────────────────
  it('returns user and system messages by reference', () => {
    const userMsg: ContextMessage = { id: 'u1', role: 'user', content: 'hello' } as ContextMessage;
    const systemMsg: ModelMessage = { role: 'system', content: 'sys prompt' };

    const result = sanitizeMessagesForModel([userMsg, systemMsg as any], 'any-model');
    expect(result[0]).toBe(userMsg);
    expect(result[1]).toBe(systemMsg);
  });

  // ── Case 9: Input is not mutated ───────────────────────────────────────
  it('does not mutate the input messages', () => {
    const originalProviderOptions = { openai: { itemId: 'rs_1' } };
    const originalPartProviderOptions = { anthropic: { signature: 'sig' } };
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openai/gpt-4',
        content: [makeReasoningPart('text', originalPartProviderOptions)],
        providerOptions: originalProviderOptions,
      } as ContextAssistantMessage,
    ];

    // Deep-freeze simulation: capture references before call
    const beforeMsg = msgs[0];
    const beforeParts = (beforeMsg as any).content as any[];
    const beforePart = beforeParts[0];

    sanitizeMessagesForModel(msgs, 'other-model');

    // Original objects unchanged
    expect((beforeMsg as any).providerOptions).toBe(originalProviderOptions);
    expect(beforePart.providerOptions).toBe(originalPartProviderOptions);
    expect(beforePart.text).toBe('text');
    expect(beforeParts.length).toBe(1);
  });

  // ── Case 10: Invariant check ───────────────────────────────────────────
  it('preserves tool-call-to-tool-result pairing after sanitisation', () => {
    const msgs: ContextMessage[] = [
      {
        id: '1',
        role: 'assistant',
        model: 'openai/gpt-4',
        content: [
          makeToolCallPart('tc1', 'search', { q: 'foo' }, { google: { thoughtSignature: 'TS1' } }),
          makeToolCallPart('tc2', 'read', { path: '/tmp/x' }, { google: { thoughtSignature: 'TS2' } }),
        ],
      } as ContextAssistantMessage,
      {
        id: '2',
        role: 'tool',
        content: [
          makeToolResultPart('tc1', 'search', { type: 'text', value: 'result1' }, { anthropic: { signature: 'SIG1' } }),
          makeToolResultPart('tc2', 'read', { type: 'text', value: 'content' }, { anthropic: { signature: 'SIG2' } }),
        ],
      } as ContextToolMessage,
    ];

    const result = sanitizeMessagesForModel(msgs, 'other-model') as ContextMessage[];

    // Collect tool-call ids and tool-result ids
    const tcIds = new Set<string>();
    const trIds = new Set<string>();

    for (const msg of result) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === 'tool-call') tcIds.add(part.toolCallId);
        }
      }
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === 'tool-result') trIds.add(part.toolCallId);
        }
      }
    }

    expect(tcIds.size).toBe(2);
    expect(trIds.size).toBe(2);
    expect(tcIds).toEqual(trIds);
  });
});
