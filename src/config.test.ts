import { describe, expect, it } from 'vitest';

import { parseModelContextLimits } from './config.js';

describe('parseModelContextLimits', () => {
  it('parses comma-separated model=limit pairs (model names may contain colons)', () => {
    expect(
      parseModelContextLimits('gemma4:26b=32768,claude-opus-4-8=200000'),
    ).toEqual({
      'gemma4:26b': 32768,
      'claude-opus-4-8': 200000,
    });
  });

  it('returns an empty object for empty or undefined input', () => {
    expect(parseModelContextLimits(undefined)).toEqual({});
    expect(parseModelContextLimits('')).toEqual({});
  });

  it('ignores malformed entries and keeps valid ones', () => {
    expect(parseModelContextLimits('good=100,bad,=5,x=notnum, spaced = 200 ')).toEqual(
      { good: 100, spaced: 200 },
    );
  });
});
