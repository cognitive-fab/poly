// plan-e3.md E3.4: the store transport the handlers' store capability is built over (PT6.5): tables of keyed rows, in
// memory here, so a run leaves nothing on disk but the runtime's own store. `dump` lists every row as text, for the canary
// scan over what a run left (AC18, S554).
const SEP = String.fromCharCode(0);

export class MemoryStore {
  #rows = new Map();
  /** The writes a handler made through the store capability, as [table, key]; the host's own puts are not among them. */
  handlerWrites = [];

  read(table, key) {
    const v = this.#rows.get(`${table}${SEP}${key}`);
    return v === undefined ? undefined : structuredClone(v);
  }

  /** What the store capability calls: a handler's write, which is logged. */
  write(table, key, value) {
    this.handlerWrites.push([table, key]);
    this.#rows.set(`${table}${SEP}${key}`, structuredClone(value));
  }

  /** The host's own writes (a recording, a table the host fills): the same row, not counted among a handler's writes. */
  put(table, key, value) {
    this.#rows.set(`${table}${SEP}${key}`, structuredClone(value));
  }

  /** Every row as [where, text], for a scan of what a run left. */
  dump() {
    return [...this.#rows].map(([k, v]) => [`store ${k.replace(SEP, '/')}`, JSON.stringify(v)]);
  }

  /** The rows of one table, as [key, value]. */
  table(name) {
    return [...this.#rows].filter(([k]) => k.startsWith(`${name}${SEP}`)).map(([k, v]) => [k.slice(name.length + 1), structuredClone(v)]);
  }
}
