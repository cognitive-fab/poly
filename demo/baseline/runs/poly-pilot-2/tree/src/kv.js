// A small table store the host keeps beside the runtime: the records the reply handlers read. One JSON file, written
// whole through a temporary name on each change, so a restart finds what a pending reply needs. No file: in memory.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class TableStore {
  #file
  #tables

  constructor(file = null) {
    this.#file = file
    this.#tables = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }

  get(table, key) {
    return this.#tables[table]?.[key] ?? null
  }

  set(table, key, value) {
    ;(this.#tables[table] ??= {})[key] = value
    if (!this.#file) return
    mkdirSync(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.#tables, null, 2))
    renameSync(tmp, this.#file)
  }
}
