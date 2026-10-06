// Journals — the {pre,action,data,post,decision} stream (docs/polyman-spec.md
// §12). This is exactly what polysec-guard / polyrun audit already consume.
import { appendFileSync } from 'node:fs';
import type { Journal, JournalEntry } from './types.ts';

export function memoryJournal(): Journal & { entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  return {
    entries,
    append(e: JournalEntry) {
      entries.push(e);
    },
    read() {
      return entries;
    },
  };
}

/** Appends ndjson to a file AND keeps an in-memory tail for read(). */
export function fileJournal(path: string): Journal {
  const entries: JournalEntry[] = [];
  return {
    append(e: JournalEntry) {
      entries.push(e);
      appendFileSync(path, JSON.stringify(e) + '\n');
    },
    read() {
      return entries;
    },
  };
}
