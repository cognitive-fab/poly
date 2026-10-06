// guard — the runtime belief-set diagnoser + shield, self-contained in the
// package (docs/polyman-spec.md §7; ported from scripts/polysec-guard.mjs). It
// consumes the {pre,action,data,post} journal polyman already produces and
// maintains a BELIEF over a variable the observer cannot see directly (a
// manufactured edge emits no event for it). Coupling SENSORS expand that belief;
// the alarm fires on the per-region semantics (possible / certain) — often
// BEFORE the hidden variable is directly observed. On alarm the shield fires a
// corrective nap through the same engine. $0 API.
import { loadMachine } from './load-machine.ts';
import { makeEngine } from './engine.ts';
import { compileRegion } from './region.ts';
import type { SamState } from './types.ts';

/** A coupling sensor: reaching `fires` is evidence the hidden variable may hold `possibleValue`. */
export interface GuardSensor {
  name: string;
  fires: (post: SamState) => boolean;
  infers: { variable: string; possibleValue: unknown };
}

export interface GuardEntry {
  action?: string;
  post: SamState;
}

export interface GuardOptions {
  journal: GuardEntry[];
  sensors: GuardSensor[];
  /** The forbidden-region predicate (over the state variables). */
  regionPredicate: string;
  stateKeys: string[];
  /** The variable the runtime observer cannot see directly (default 'egress'). */
  hidden?: string;
  alarmSemantics?: 'possible' | 'certain';
  /** Optional: fire a corrective nap through this machine on alarm. */
  machine?: string;
  shieldNap?: string;
}

export interface GuardResult {
  alarm: null | { step: number; action?: string; semantics: string; sensorsFired: string[]; directlyObserved: boolean };
  shield: null | { fired: string; before: SamState; after: SamState };
  log: Array<{ step: number; action?: string; believedHidden: unknown[]; sensorsFired: string[]; regionPossible: boolean; regionCertain: boolean; alarm: boolean }>;
}

export function runGuard(opts: GuardOptions): GuardResult {
  const hidden = opts.hidden ?? 'egress';
  const inRegion = compileRegion(opts.regionPredicate, opts.stateKeys);
  const semantics = opts.alarmSemantics ?? 'possible';

  // Sensor-INFERRED possible values of the hidden variable, accumulated across
  // the journal (an inference, once made, stays possible).
  const inferred = new Set<unknown>();
  const log: GuardResult['log'] = [];
  let alarm: GuardResult['alarm'] = null;

  for (let i = 0; i < opts.journal.length; i++) {
    const { action, post } = opts.journal[i];
    const fired: string[] = [];
    for (const s of opts.sensors) {
      if (s.infers.variable === hidden && s.fires(post)) { inferred.add(s.infers.possibleValue); fired.push(s.name); }
    }
    // The belief is the DIRECTLY-OBSERVED value of the hidden variable (ground
    // truth from the journal — a modeled region entry must not be missed) UNION
    // the sensor inferences (which catch an UNMODELED edge the journal doesn't
    // record). Seeding only {false} would ignore an observable region entry.
    const believed = new Set<unknown>([post[hidden], ...inferred]);
    const consistent = [...believed].map((h) => ({ ...post, [hidden]: h }));
    const anyIn = consistent.some(inRegion);
    const allIn = consistent.every(inRegion);
    const raise = semantics === 'certain' ? allIn : anyIn;
    log.push({ step: i, action, believedHidden: [...believed], sensorsFired: fired, regionPossible: anyIn, regionCertain: allIn, alarm: raise });
    if (raise && !alarm) {
      alarm = { step: i, action, semantics, sensorsFired: fired, directlyObserved: post[hidden] === true };
      break; // the shield fires on first alarm
    }
  }

  let shield: GuardResult['shield'] = null;
  if (alarm && opts.machine && opts.shieldNap) {
    const { step } = makeEngine(loadMachine(opts.machine) as never);
    const before = opts.journal[alarm.step].post;
    const res = step(JSON.parse(JSON.stringify(before)), opts.shieldNap, {});
    shield = { fired: opts.shieldNap, before, after: res.post };
  }

  return { alarm, shield, log };
}
