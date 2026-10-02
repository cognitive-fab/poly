import type { BookView, CreateHost, Host, Outcome } from '../host.ts';

export const MAX_LOANS = 3;

type Book = BookView;

const ok = (): Outcome => ({ ok: true });
const no = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const books = new Map<string, Book>();

  const host: Host = {
    async add(id) {
      if (books.has(id)) return no('book-exists');
      books.set(id, { status: 'available', loans: 0, renewed: false });
      return ok();
    },
    async lend(id) {
      const b = books.get(id);
      if (!b) return no('unknown-book');
      if (b.status === 'retired') return no('retired-is-final');
      if (b.status !== 'available') return no('not-available');
      if (b.loans >= MAX_LOANS) return no('loan-limit');
      books.set(id, { status: 'lent', loans: b.loans + 1, renewed: false });
      return ok();
    },
    async giveBack(id) {
      const b = books.get(id);
      if (!b) return no('unknown-book');
      if (b.status === 'retired') return no('retired-is-final');
      if (b.status !== 'lent') return no('not-lent');
      books.set(id, { status: 'available', loans: b.loans, renewed: false });
      return ok();
    },
    async retire(id) {
      const b = books.get(id);
      if (!b) return no('unknown-book');
      if (b.status === 'retired') return no('retired-is-final');
      if (b.status !== 'available') return no('not-available');
      books.set(id, { status: 'retired', loans: b.loans, renewed: false });
      return ok();
    },
    async renew(id) {
      const b = books.get(id);
      if (!b) return no('unknown-book');
      if (b.status === 'retired') return no('retired-is-final');
      if (b.status !== 'lent') return no('not-lent');
      if (b.renewed) return no('already-renewed');
      books.set(id, { status: 'lent', loans: b.loans, renewed: true });
      return ok();
    },
    async book(id) {
      const b = books.get(id);
      return b ? { status: b.status, loans: b.loans, renewed: b.renewed } : null;
    },
  };
  return host;
};

export default createHost;
