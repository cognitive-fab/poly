import type { BookView, CreateHost, Host, Outcome } from '../host.ts';

const MAX_LOANS = 3;

type Book = { status: BookView['status']; loans: number; renewed: boolean };

const ok = (): Outcome => ({ ok: true });
const no = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const books = new Map<string, Book>();

  const host: Host = {
    async add(id) {
      if (books.has(id)) return no(`book ${id} already exists`);
      books.set(id, { status: 'available', loans: 0, renewed: false });
      return ok();
    },
    async lend(id) {
      const b = books.get(id);
      if (!b) return no(`no book ${id}`);
      if (b.status !== 'available') return no(`book ${id} is ${b.status}`);
      if (b.loans >= MAX_LOANS) return no(`book ${id} has reached ${MAX_LOANS} loans`);
      b.status = 'lent';
      b.loans += 1;
      b.renewed = false;
      return ok();
    },
    async giveBack(id) {
      const b = books.get(id);
      if (!b) return no(`no book ${id}`);
      if (b.status !== 'lent') return no(`book ${id} is ${b.status}, not lent`);
      b.status = 'available';
      return ok();
    },
    async retire(id) {
      const b = books.get(id);
      if (!b) return no(`no book ${id}`);
      if (b.status !== 'available') return no(`book ${id} is ${b.status}, not available`);
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
