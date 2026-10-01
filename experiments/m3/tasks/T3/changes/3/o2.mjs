// T3 O2 after change 3: the hidden invariants, over the observations of explore.json (scoring only).
const payments = (o) => Object.values(o.payment).filter((v) => v !== null);

export default [
  { name: 'capture-within-authorization', holds: (o) => payments(o).every((v) => v.captured <= v.authorized) },
  { name: 'refund-within-capture', holds: (o) => payments(o).every((v) => v.refunded <= v.captured) },
  { name: 'voided-captured-nothing', holds: (o) => payments(o).every((v) => v.status !== 'voided' || v.captured === 0) },
  { name: 'refunded-means-all-returned', holds: (o) => payments(o).every((v) => v.status !== 'refunded' || (v.refunded === v.captured && v.captured >= 1)) },
  { name: 'at-most-three-requests', holds: (o) => payments(o).every((v) => v.requests >= 1 && v.requests <= 3) },
  { name: 'authorized-at-most-three', holds: (o) => payments(o).every((v) => v.authorized >= 1 && v.authorized <= 3) },
  { name: 'expired-captured-nothing', holds: (o) => payments(o).every((v) => v.status !== 'expired' || v.captured === 0) },
  { name: 'nothing-moves-before-authorization', holds: (o) => payments(o).every((v) => !['authorizing', 'declined', 'failed'].includes(v.status) || (v.captured === 0 && v.refunded === 0)) },
];
