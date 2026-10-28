import { describe, expect, it } from 'vitest';

import { resolveTopLevelMessageId } from '../resolve-scroll-target';

const message = (id: string) => ({ id, type: 'user', content: '' }) as any;

describe('resolveTopLevelMessageId', () => {
  it('matches direct messages', () => expect(resolveTopLevelMessageId([message('a')], 'a')).toBe('a'));
  it('resolves nested groups', () => {
    const group = { ...message('g'), type: 'group', children: [{ ...message('n'), type: 'group', children: [message('c')] }] } as any;
    expect(resolveTopLevelMessageId([group], 'c')).toBe('g');
  });
  it('resolves assistant groups', () => {
    const group = { ...message('g'), type: 'assistant-group', responseMessage: message('r'), toolMessages: [message('t')] } as any;
    expect(resolveTopLevelMessageId([group], 't')).toBe('g');
  });
  it('returns undefined when absent', () => expect(resolveTopLevelMessageId([message('a')], 'missing')).toBeUndefined());
});
