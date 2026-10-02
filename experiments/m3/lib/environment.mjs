// The environment every arm shares (S116): the Node version, the claude CLI's version, the exact model id and the
// operating system. They do not bias a comparison, since every arm has them, but a run cannot be reproduced
// without them, and a CLI update between runs would change every arm mid-experiment. freeze.json records them,
// and the runner refuses a run, pilots included, when the Node version, the CLI version or the model differs from
// the record; an OS release change is recorded and reported (M3-10).
import { execFileSync } from 'node:child_process';
import { arch, platform, release } from 'node:os';

/** The fields of the record, sorted: environmentDiff names them in this order. */
const FIELDS = ['claude', 'model', 'node', 'os'];

/**
 * An exact model id, as the CLI is given it: `claude-<family>-<version>`, with an optional date and context
 * suffix. An alias (`opus`, `sonnet`, `opusplan`, `default`) names whatever model the CLI maps it to that day.
 */
export function isExactModelId(id) {
  return typeof id === 'string' && /^claude-[a-z]+(-\d+)+(\[1m\])?$/.test(id);
}

/** The environment of this process, with `model` the id the runner passes to the CLI. */
export function currentEnvironment({ model, claudeBin = 'claude' }) {
  return {
    node: process.version,
    claude: execFileSync(claudeBin, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[0],
    model,
    os: { platform: platform(), release: release(), arch: arch() },
  };
}

/** The fields that differ between the record and the current environment; a missing record differs in every field. */
export function environmentDiff(recorded, current) {
  return FIELDS.filter((k) => JSON.stringify(recorded?.[k]) !== JSON.stringify(current?.[k]));
}

/**
 * The differences that refuse a run (M3-10): the Node version, the claude CLI version and the model id, which
 * change what the agent sees or how it runs. An operating system release change is recorded in the run's record
 * and reported, not refused: an OS patch does not change what the agent sees.
 */
export function refusalDiff(recorded, current) {
  return environmentDiff(recorded, current).filter((k) => k !== 'os');
}
