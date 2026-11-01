// DB6 item 12 (g), finding 33: the five driver test files take `test` from here, so that each of their tests has a timeout and a
// test that does not end is reported under its own name. Measured with Node 24.12: the timeout names the test, and the bounds of the
// driver (DB6 item 12 (b) to (e)) are what let its file end.
import { test as nodeTest, before, after } from 'node:test';

/** 300000 ms, ten times the longest driver test of the loaded parallel run of 2026-10-31 (30.7 s); POLY_DRIVER_TEST_MS replaces it. */
function driverTestMs() {
  const raw = process.env.POLY_DRIVER_TEST_MS;
  if (raw === undefined) return 300_000;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`POLY_DRIVER_TEST_MS must be a whole number above 0, not ${JSON.stringify(raw)}`);
  return Number(raw);
}

export const DRIVER_TEST_MS = driverTestMs();

/** node:test's test, with the timeout under the options a call gives (a call's own timeout wins). */
export function test(name, options, fn) {
  if (typeof options === 'function') return nodeTest(name, { timeout: DRIVER_TEST_MS }, options);
  return nodeTest(name, { timeout: DRIVER_TEST_MS, ...options }, fn);
}
test.before = before;
test.after = after;
