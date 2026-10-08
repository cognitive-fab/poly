// M11 step 2 (PS18.3, S350): money in integer micro-units, price tables with their source and date (PL6843), and the
// reservation and cost a tier's call is charged by. Every amount is exact: no binary fraction is ever rounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, priceTableProblem, reservationOf, costOf, MICRO, CODES } from '@poly/core';

// Test prices, not a provider's: the source is a placeholder of the right shape.
const TABLE = { v: 1, provider: 'flash', model: 'flash-2026-09', currency: 'usd', perMillionTokens: { input: 300_000, output: 2_500_000 }, source: 'https://example.com/pricing', readOn: '2026-10-07' };

test('S350: an amount in decimal is an exact count of micro-units, and back', () => {
  assert.equal(MICRO, 1_000_000);
  assert.equal(parseAmount('0.50'), 500_000);
  assert.equal(parseAmount('20.00'), 20_000_000);
  assert.equal(parseAmount('0.1'), 100_000);
  assert.equal(parseAmount('0.000001'), 1);
  assert.equal(parseAmount('7'), 7_000_000);
  // 0.1 + 0.2 is not 0.3 in binary; in micro-units it is.
  assert.equal(parseAmount('0.1') + parseAmount('0.2'), parseAmount('0.3'));
  for (const bad of ['0.0000001', '-1', '1e3', '.5', '1.', '', 'usd', '9007199254.740992']) assert.equal(parseAmount(bad), null, bad);
  assert.equal(formatAmount(500_000), '0.5');
  assert.equal(formatAmount(20_000_000), '20');
  assert.equal(formatAmount(1), '0.000001');
  assert.equal(formatAmount(-1_250_000), '-1.25');
});

test('S350: a price table names its provider, model, currency, classes, source and date', () => {
  assert.equal(priceTableProblem(TABLE, 'flash'), null);
  assert.deepEqual(priceTableProblem(TABLE, 'opus')?.code, 'PL1201');
  assert.equal(priceTableProblem({ ...TABLE, v: 2 }, 'flash')?.code, 'PL1201');
  assert.equal(priceTableProblem({ ...TABLE, model: '' }, 'flash')?.code, 'PL1201');
  assert.equal(priceTableProblem({ ...TABLE, currency: 'USD' }, 'flash')?.code, 'PL1201');
  assert.equal(priceTableProblem({ ...TABLE, perMillionTokens: {} }, 'flash')?.code, 'PL1201');
  assert.equal(priceTableProblem({ ...TABLE, perMillionTokens: { input: 0.3 } }, 'flash')?.code, 'PL1201', 'a price is a whole number of micro-units');
  assert.equal(priceTableProblem({ ...TABLE, perMillionTokens: { Input: 1 } }, 'flash')?.code, 'PL1201');
  assert.equal(priceTableProblem([], 'flash')?.code, 'PL1201');
});

test('PL6843: a price table without its https source or the date it was read is unsourced', () => {
  assert.equal(CODES.PL6843.name, 'PRICE_UNSOURCED');
  const { source, readOn, ...bare } = TABLE;
  for (const t of [bare, { ...TABLE, source: '' }, { ...TABLE, source: 'http://example.com/pricing' }, { ...TABLE, source: 'pricing page' }, { ...TABLE, readOn: undefined }, { ...TABLE, readOn: 'October' }, { ...TABLE, readOn: '2026-13-40' }]) {
    const p = priceTableProblem(t, 'flash');
    assert.equal(p?.code, 'PL6843', JSON.stringify(t));
    assert.match(p.message, /source/);
  }
  assert.ok(source && readOn);
});

test('PS18.3, S360: a reservation is the input limit at the input price and the output limit at the highest other price, rounded up', () => {
  // 4000 output tokens at 2.5 per million: 0.01, exactly 10,000 micro-units.
  assert.equal(reservationOf(0, 4000, TABLE), 10_000);
  // 1000 input tokens at 0.3 per million, beside them: 300 more.
  assert.equal(reservationOf(1000, 4000, TABLE), 10_300);
  // 1 token at 2.5 per million is 2.5 micro-units, rounded up to 3: a reservation never falls short of the price.
  assert.equal(reservationOf(0, 1, TABLE), 3);
  assert.equal(reservationOf(0, 0, TABLE), 0);
  // A table with no input class reserves the input at its highest price, so the reservation never falls short.
  assert.equal(reservationOf(1000, 0, { perMillionTokens: { output: 2_500_000 } }), 2_500);
});

test('S360, ruled: a call within both its limits records no overrun; beyond either, it does', () => {
  const r = reservationOf(1000, 4000, TABLE);
  assert.ok(costOf({ input: 1000, output: 4000 }, TABLE).cost <= r, 'both limits used in full');
  assert.ok(costOf({ input: 1001, output: 4000 }, TABLE).cost > r, 'beyond the input limit');
  assert.ok(costOf({ input: 1000, output: 4001 }, TABLE).cost > r, 'beyond the output limit');
});

test('PS18.3: a cost is each class at its price, rounded up once, and an unpriced class takes the highest price', () => {
  // 1000 input at 0.3 and 500 output at 2.5 per million: 300 + 1250 micro-units.
  assert.deepEqual(costOf({ input: 1000, output: 500 }, TABLE), { cost: 1550, unpriced: [] });
  // Rounded once over the sum: 1 + 1 input tokens are 0.6, so 1 micro-unit, not 2.
  assert.deepEqual(costOf({ input: 2 }, TABLE), { cost: 1, unpriced: [] });
  assert.deepEqual(costOf({ input: 1000, reasoning: 100 }, TABLE), { cost: 550, unpriced: ['reasoning'] });
  assert.deepEqual(costOf({}, TABLE), { cost: 0, unpriced: [] });
  assert.throws(() => costOf({ input: -1 }, TABLE), /K15/);
  assert.throws(() => costOf({ input: 1.5 }, TABLE), /K15/);
});
