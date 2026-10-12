import { describe, it, expect } from 'vitest';
import { fuzzyFilter } from '../../../src/utils/fuzzy-match.js';

describe('fuzzyFilter order', () => {
  it('puts the exact match first, then the prefix match, then the substring match', () => {
    const items = ['Please fix it', 'Fix it today', 'fix'];
    expect(fuzzyFilter('fix', items, (s) => s)).toEqual(['fix', 'Fix it today', 'Please fix it']);
  });
});
