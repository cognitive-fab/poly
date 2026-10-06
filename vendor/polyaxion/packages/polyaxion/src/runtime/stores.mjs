// The kernel's two seams over SQLite: SessionStore (Σ per session) and Journal (windows).
//
// The owner process is the single writer; the store is the only durable truth.
// A Journal append that throws is the kernel's cue to degrade the record, never
// the decision (SS-3) — so this adapter throws honestly instead of swallowing.
import { canon } from '../core/canon.mjs';

export class SqliteSessionStore {
  /**
   * @param {import('../store/store.mjs').Store} store
   * @param {object} opts { scope, init: () => SamState, policySet }
   */
  constructor(store, opts) {
    this.store = store; this.scope = opts.scope; this.init = opts.init; this.policySet = opts.policySet ?? null; this.historyWindow = opts.historyWindow ?? 500;
    this.cache = new Map();
  }
  get(id) {
    const c = this.cache.get(id);
    if (c) return c.state;
    const row = this.store.getSession(id, this.historyWindow);
    if (row) {
      if (row.policy_set !== this.policySet) {
        // the composite changed under a live session: keys shared with the new machine carry over, new keys start at initial
        const fresh = this.init();
        const next = {}; for (const k of Object.keys(fresh)) next[k] = Object.prototype.hasOwnProperty.call(row.state, k) ? row.state[k] : fresh[k];
        row.migrated = row.policy_set; row.state = next; row.policy_set = this.policySet;
        this.store.putSession(row);
      }
      this.cache.set(id, row); return row.state;
    }
    const fresh = { session_id: id, scope: this.scope, status: 'active', step: 0, state: this.init(), history: [], policy_set: this.policySet };
    this.store.putSession(fresh);
    this.cache.set(id, fresh);
    return fresh.state;
  }
  set(id, state) {
    const row = this.cache.get(id) ?? this.store.getSession(id, this.historyWindow) ?? { session_id: id, scope: this.scope, status: 'active', step: 0, history: [], policy_set: this.policySet };
    row.state = state; // step, status and history are polyaxion's, advanced by the Gate after a committed decision
    this.store.putSession(row);
    this.cache.set(id, row);
  }
  /** polyaxion-owned metadata beside Σ: step, status, history window. */
  meta(id) { this.get(id); return this.cache.get(id); }
  update(id, fn) { const row = this.meta(id); fn(row); this.store.putSession(row); this.cache.set(id, row); return row; }
}

export class SqliteJournal {
  /**
   * @param {object} [opts] { discharge?: (post) => { machine: { state, discharged } }, witness?: (entry) => witness|null }
   * discharge — mandate m4: the window that ends a session says whether it ended lawfully;
   * witness — 05 §3: a reject window carries the witness the verdict returned, computed here at append time.
   */
  constructor(store, opts = {}) { this.store = store; this.discharge = opts.discharge ?? null; this.witness = opts.witness ?? null; }
  append(e) {
    const ends = this.discharge && e.decision === 'allow' && Array.isArray(e.action) && e.action.includes('END');
    let row = ends ? { ...e, discharge: this.discharge(e.post) } : e;
    if (this.witness && e.decision === 'reject') { const w = this.witness(e); if (w) row = { ...row, witness: w }; }
    this.store.appendWindow(e.session, row, !!e.spilled);
  }
  read() { return this.store.readWindows({ limit: 10_000 }); }
}

export { canon };
