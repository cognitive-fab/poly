import type { CreateHost, Host, Outcome, BookView } from '../host.ts';
import { decide } from './core.ts';
import type { Books, Command } from './core.ts';

const createHost: CreateHost = async () => {
  let books: Books = {};
  const run = (command: Command, id: string): Outcome => {
    if (typeof id !== 'string') return { ok: false, reason: 'invalid-book-id' };
    const d = decide(books, command, id);
    if (!d.ok) return { ok: false, reason: d.reason };
    books = d.books;
    return { ok: true };
  };
  const host: Host = {
    add: async (id) => run('add', id),
    lend: async (id) => run('lend', id),
    giveBack: async (id) => run('giveBack', id),
    retire: async (id) => run('retire', id),
    renew: async (id) => run('renew', id),
    book: async (id): Promise<BookView | null> => {
      if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(books, id)) return null;
      const b = books[id];
      return { status: b.status, loans: b.loans, renewed: b.status === 'lent' && b.renewed };
    },
  };
  return host;
};

export default createHost;
