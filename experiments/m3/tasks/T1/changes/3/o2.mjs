// T1 O2 after change 3: the hidden invariants, over the observations of explore.json (scoring only).
const orders = (o) => Object.values(o.order).filter((v) => v !== null);

export default [
  { name: 'charged-at-most-twice', holds: (o) => orders(o).every((v) => v.charges <= 2) },
  { name: 'refund-only-when-cancelled', holds: (o) => orders(o).every((v) => v.refunds === 0 || (v.status === 'cancelled' && v.charges >= 1 && v.refunds === 1)) },
  { name: 'shipped-was-paid-and-not-refunded', holds: (o) => orders(o).every((v) => v.status !== 'shipped' || (v.charges >= 1 && v.refunds === 0)) },
  { name: 'placed-orders-hold-items', holds: (o) => orders(o).every((v) => !['placed', 'paid', 'shipped', 'cancelling', 'declined', 'failed'].includes(v.status) || v.items >= 1) },
  { name: 'items-within-limit', holds: (o) => orders(o).every((v) => v.items >= 0 && v.items <= 3) },
  { name: 'only-paid-orders-are-held', holds: (o) => orders(o).every((v) => !v.held || v.status === 'paid') },
  { name: 'no-refund-while-cancelling', holds: (o) => orders(o).every((v) => v.status !== 'cancelling' || v.refunds === 0) },
];
