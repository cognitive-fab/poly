// Session stores. Each session gets its own taint record (FR-4); two sessions
// never share one. A missing session starts at the machine's init state.
import type { SamState, SessionStore } from './types.ts';

export function memoryStore(init: () => SamState): SessionStore {
  const m = new Map<string, string>(); // id -> canonical JSON (value copies, no aliasing)
  return {
    get(id: string): SamState {
      const s = m.get(id);
      return s ? JSON.parse(s) : init();
    },
    set(id: string, s: SamState): void {
      m.set(id, JSON.stringify(s));
    },
  };
}
