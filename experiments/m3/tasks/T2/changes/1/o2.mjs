// T2 O2 after change 1: the hidden invariants, over the observations of explore.json and the messages in transit (scoring only).
const orders = (o) => Object.values(o.order).filter((v) => v !== null);
const stock = (o) => Object.values(o.stock)[0];
const confirmedUnits = (o) => orders(o).filter((v) => v.status === 'confirmed').reduce((n, v) => n + v.qty, 0);

export default [
  { name: 'within-capacity', holds: (o) => stock(o).available >= 0 && stock(o).reserved >= 0 && stock(o).available + stock(o).reserved <= 3 },
  { name: 'reserved-covers-confirmed', holds: (o) => stock(o).reserved >= confirmedUnits(o) },
  { name: 'quiescent-reservations-are-exact', holds: (o, transit) => transit.length > 0 || stock(o).reserved === confirmedUnits(o) },
  { name: 'quantities-are-one-or-two', holds: (o) => orders(o).every((v) => v.qty === 1 || v.qty === 2) },
];
