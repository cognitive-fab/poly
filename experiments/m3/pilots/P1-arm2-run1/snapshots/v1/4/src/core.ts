// Pure decision core for book loans. No I/O, no clock: the host wraps it, and
// the polygraph spec (spec/loans.spec.cjs) mirrors it rule for rule.

export type Status = 'available' | 'lent' | 'retired';
/** renewed: whether the current loan was renewed; always false unless lent. */
export interface Book { status: Status; loans: number; renewed: boolean; }
export type Books = Record<string, Book>;
export type Command = 'add' | 'lend' | 'giveBack' | 'retire' | 'renew';
export type Decision = { ok: true; books: Books } | { ok: false; reason: string };

export const MAX_LOANS = 3;

export function decide(books: Books, command: Command, id: string): Decision {
  const has = Object.prototype.hasOwnProperty.call(books, id);
  if (command === 'add') {
    if (has) return { ok: false, reason: 'book-exists' };
    return { ok: true, books: { ...books, [id]: { status: 'available', loans: 0, renewed: false } } };
  }
  if (!has) return { ok: false, reason: 'unknown-book' };
  const b = books[id];
  if (b.status === 'retired') return { ok: false, reason: 'book-retired' };
  switch (command) {
    case 'lend':
      if (b.status !== 'available') return { ok: false, reason: 'not-available' };
      if (b.loans >= MAX_LOANS) return { ok: false, reason: 'loan-limit-reached' };
      return { ok: true, books: { ...books, [id]: { status: 'lent', loans: b.loans + 1, renewed: false } } };
    case 'giveBack':
      if (b.status !== 'lent') return { ok: false, reason: 'not-lent' };
      return { ok: true, books: { ...books, [id]: { status: 'available', loans: b.loans, renewed: false } } };
    case 'retire':
      if (b.status !== 'available') return { ok: false, reason: 'not-available' };
      return { ok: true, books: { ...books, [id]: { status: 'retired', loans: b.loans, renewed: false } } };
    case 'renew':
      if (b.status !== 'lent') return { ok: false, reason: 'not-lent' };
      if (b.renewed) return { ok: false, reason: 'already-renewed' };
      return { ok: true, books: { ...books, [id]: { status: 'lent', loans: b.loans, renewed: true } } };
    default:
      return { ok: false, reason: 'unknown-command' };
  }
}
