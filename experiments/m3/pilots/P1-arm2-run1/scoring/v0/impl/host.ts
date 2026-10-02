// P1, book loans: a practice task for pilot runs, never scored with T1 to T10.

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export interface BookView {
  status: 'available' | 'lent' | 'retired';
  loans: number;
}

export interface Host {
  add(book: string): Promise<Outcome>;
  lend(book: string): Promise<Outcome>;
  giveBack(book: string): Promise<Outcome>;
  retire(book: string): Promise<Outcome>;
  /** The book, or null when no book has that id. */
  book(book: string): Promise<BookView | null>;
}

/** The module's default export: a factory of a fresh system, with no books. */
export type CreateHost = () => Promise<Host>;
