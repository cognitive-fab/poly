// plan-e3.md E3.4: the store transport the handlers' store capability is built over (PT6.5): tables of keyed rows, in
// memory here, so a run leaves nothing on disk but the runtime's own store. `dump` lists every row as text, for the canary
// scan over what a run left (AC18, S554).
export class MemoryStore {
  #rows = new Map();

  read(table, key) {
    const v = this.#rows.get(`${table}\u0000${key}`);
    return v === undefined ? undefined : structuredClone(v);
  }

  write(table, key, value) {
    this.#rows.set(`${table}\u0000${key}`, structuredClone(value));
  }

  /** The host's own writes (a recording, a table the host fills) use the same call. */
  put(table, key, value) {
    this.write(table, key, value);
  }

  /** Every row as [where, text], for a scan of what a run left. */
  dump() {
    return [...this.#rows].map(([k, v]) => [`store ${k.replace('\u0000', '/')}`, JSON.stringify(v)]);
  }

  /** The rows of one table, as [key, value]. */
  table(name) {
    return [...this.#rows].filter(([k]) => k.startsWith(`${name}\u0000`)).map(([k, v]) => [k.slice(name.length + 1), structuredClone(v)]);
  }
}
