import type { BookView, CreateHost, Host, Outcome } from '../host.ts';

const MAX_LOANS = 3;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const books = new Map<string, BookView>();

  const host: Host = {
    async add(id) {
      if (books.has(id)) return refuse('book already exists');
      books.set(id, { status: 'available', loans: 0 });
      return ok();
    },
    async lend(id) {
      const b = books.get(id);
      if (!b) return refuse('no such book');
      if (b.status !== 'available') return refuse(`book is ${b.status}`);
      if (b.loans >= MAX_LOANS) return refuse('book has reached its loan limit');
      b.status = 'lent';
      b.loans += 1;
      return ok();
    },
    async giveBack(id) {
      const b = books.get(id);
      if (!b) return refuse('no such book');
      if (b.status !== 'lent') return refuse(`book is ${b.status}`);
      b.status = 'available';
      return ok();
    },
    async retire(id) {
      const b = books.get(id);
      if (!b) return refuse('no such book');
      if (b.status !== 'available') return refuse(`book is ${b.status}`);
      b.status = 'retired';
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
