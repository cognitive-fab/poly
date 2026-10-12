import { describe, it, expect } from 'vitest';
import { nextOccurrence } from '../../../src/core/recurrence.js';

const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

describe('monthly rule at the end of a month', () => {
  it('clamps January 31 to the end of February', () => {
    expect(ymd(nextOccurrence({ type: 'monthly', interval: 1 }, new Date(2026, 0, 31, 12, 0, 0)))).toEqual([2026, 2, 28]);
  });

  it('keeps the day of the month when the next month has it', () => {
    expect(ymd(nextOccurrence({ type: 'monthly', interval: 1 }, new Date(2026, 0, 15, 12, 0, 0)))).toEqual([2026, 2, 15]);
  });

  it('honours dayOfMonth 31 in a 30-day month', () => {
    expect(ymd(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 31 }, new Date(2026, 2, 31, 12, 0, 0)))).toEqual([2026, 4, 30]);
  });
});
