// DF10: the spend meter of a live or stub launch. Every request to the model provider goes through `meteredTransport`, and the meter
// keeps the spend under the cap by construction: before a request it reserves the request's worst case, and a request whose worst case
// would cross the cap is not sent. The sums are integers of 1e-12 dollars (tokens times a price in micro-dollars per million tokens),
// so that the comparison with the cap has no rounding in it.
import { ProviderError } from '../../examples/inbox/host/providers.mjs';
import { LaunchRefused } from './launch-refused.mjs';

export const MAX_CAP_USD = 10;
const UNIT = 1e12; // one dollar, in the meter's integers

/** Why a `--cap-usd` value is refused, or null. A number of digits with at most one decimal point, above 0 and at most 10 (DF10 item 1). */
export function capRefusal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return `the spend cap is a number of dollars, at most ${MAX_CAP_USD}`;
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) return `the spend cap is a number of dollars written with digits (--cap-usd 5), at most ${MAX_CAP_USD}`;
  const n = Number(text);
  if (!(n > 0)) return `the spend cap must be above 0 dollars, at most ${MAX_CAP_USD}`;
  if (n > MAX_CAP_USD) return `the spend cap is at most ${MAX_CAP_USD} dollars, not ${text}`;
  return null;
}

/** The cap as a number, or a LaunchRefused. */
export function parseCap(value) {
  const why = capRefusal(value);
  if (why) throw new LaunchRefused(why);
  return Number(value);
}

/**
 * `tables` is { [model id]: { perMillionTokens: { input, output } } }, in micro-dollars per million tokens (3000000 is 3 dollars per
 * million). `onCap` is called once, when the cap is reached.
 */
export function createSpendMeter({ capUsd, tables, onCap = () => {} }) {
  const cap = Math.round(capUsd * UNIT);
  let settled = 0;
  let reserved = 0;
  let calls = 0;
  let reached = false;
  const reach = () => { if (!reached) { reached = true; onCap(); } };
  const price = (model) => {
    const p = tables?.[model]?.perMillionTokens;
    if (!p || !Number.isSafeInteger(p.input) || !Number.isSafeInteger(p.output)) throw new ProviderError(`no price table for the model ${String(model)}: nothing was asked`);
    return p;
  };
  return {
    capUsd,
    spentUsd: () => settled / UNIT,
    calls: () => calls,
    capReached: () => reached,
    /** Reserves the worst case of a request, or throws and says that the cap is reached. */
    reserve(request) {
      let body;
      try { body = JSON.parse(request.body); } catch { throw new ProviderError('the request has no readable body to price: nothing was asked'); }
      const p = price(body?.model);
      const maxTokens = Number.isSafeInteger(body.max_tokens) && body.max_tokens >= 0 ? body.max_tokens : null;
      if (maxTokens === null) throw new ProviderError('the request has no max_tokens to price: nothing was asked');
      // A token is at least one byte, so the bytes of the body are an upper bound of the input tokens for any text (DF10 item 4).
      const worst = Buffer.byteLength(request.body) * p.input + maxTokens * p.output;
      if (settled + reserved + worst > cap) {
        reach();
        throw new ProviderError('the spend cap would be exceeded; nothing was asked');
      }
      reserved += worst;
      calls += 1;
      return { worst, price: p, open: true };
    },
    /** Replaces a reservation by the cost of the response; an Error (no answer known) is charged the worst case. */
    settle(reservation, response) {
      if (!reservation?.open) return;
      reservation.open = false;
      reserved -= reservation.worst;
      let cost = 0;
      if (response instanceof Error) cost = reservation.worst;
      else if (response?.status === 200) {
        let usage = null;
        try { usage = JSON.parse(response.body)?.usage; } catch { usage = null; }
        cost = Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens)
          ? usage.input_tokens * reservation.price.input + usage.output_tokens * reservation.price.output
          : reservation.worst;
      }
      settled += cost;
      if (settled >= cap) reach();
    },
  };
}

/** The transport the live providers use, with every request counted. */
export function meteredTransport(transport, meter) {
  return {
    async request(q) {
      const reservation = meter.reserve(q);
      let response;
      try { response = await transport.request(q); } catch (e) { meter.settle(reservation, e instanceof Error ? e : new Error(String(e))); throw e; }
      meter.settle(reservation, response);
      return response;
    },
  };
}

export const formatSpend = (meter) => `spend: $${meter.spentUsd().toFixed(4)} of $${Number(meter.capUsd).toFixed(2)} cap, ${meter.calls()} model calls`;
