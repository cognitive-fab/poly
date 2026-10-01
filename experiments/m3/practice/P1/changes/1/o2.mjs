// P1 O2 after change 1: the hidden invariants of the practice task (scoring of pilot runs only).
const books = (o) => Object.values(o.book).filter((v) => v !== null);

export default [
  { name: 'loans-within-limit', holds: (o) => books(o).every((v) => v.loans >= 0 && v.loans <= 3) },
  { name: 'lent-books-were-lent', holds: (o) => books(o).every((v) => v.status !== 'lent' || v.loans >= 1) },
  { name: 'only-loans-are-renewed', holds: (o) => books(o).every((v) => !v.renewed || v.status === 'lent') },
];
