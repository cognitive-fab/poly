// The recorded flash device of the flash controller example (docs/examples/flash-controller.md). The example has no model and no
// effect; what is recorded is what a device answers. `script` is { program, verify, erase }, each a list of 'ok' or 'fail'
// answers taken in order, the last repeating; a missing or empty list answers 'ok'. Every call is kept.

/** A device that answers from a script, and the calls it saw as { op, value? }. */
export function recordedDevice(script = {}) {
  const calls = [];
  const taken = { program: 0, verify: 0, erase: 0 };
  const answer = (op) => {
    const list = script[op];
    if (!Array.isArray(list) || !list.length) return 'ok';
    const a = list[Math.min(taken[op], list.length - 1)];
    taken[op] += 1;
    return a;
  };
  const device = {
    async program(value) { calls.push({ op: 'program', value }); return answer('program'); },
    async verify() { calls.push({ op: 'verify' }); return answer('verify'); },
    async erase() { calls.push({ op: 'erase' }); return answer('erase'); },
  };
  return { calls, device };
}
