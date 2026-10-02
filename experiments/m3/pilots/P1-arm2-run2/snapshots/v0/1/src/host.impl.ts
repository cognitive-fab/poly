import type { BookView, CreateHost, Host, Outcome } from '../host.ts';

export const MAX_LOANS = 3;

type Book = { status: BookView['status']; loans: number };

const ok = (): Outcome => ({ ok: true });
const no = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const books = new Map<string, Book>();

  const host: Host = {
    async add(id) {
      if (books.has(id)) return no('book already exists');
      books.set(id, { status: 'available', loans: 0 });
      return ok();
    },
    async lend(id) {
      const b = books.get(id);
      if (!b) return no('no such book');
      if (b.status !== 'available') return no(`book is ${b.status}`);
      if (b.loans >= MAX_LOANS) return no('book has reached its loan limit');
      books.set(id, { status: 'lent', loans: b.loans + 1 });
      return ok();
    },
    async giveBack(id) {
      const b = books.get(id);
      if (!b) return no('no such book');
      if (b.status !== 'lent') return no(`book is ${b.status}`);
      books.set(id, { status: 'available', loans: b.loans });
      return ok();
    },
    async retire(id) {
      const b = books.get(id);
      if (!b) return no('no such book');
      if (b.status !== 'available') return no(`book is ${b.status}`);
      books.set(id, { status: 'retired', loans: b.loans });
      return ok();
    },
    async book(id) {
      const b = books.get(id);
      return b ? { status: b.status, loans: b.loans } : null;
    },
  };
  return host;
};

export default createHost;
