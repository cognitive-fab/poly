// T4 O2: the hidden invariants, over the observations of explore.json and the messages in transit (scoring only).
const carts = (o) => Object.values(o.cart).filter((v) => v !== null);
const stock = (o) => Object.values(o.stock)[0];
const pay = (o) => Object.values(o.payments)[0];
const paidUnits = (o) => carts(o).filter((v) => v.status === 'paid').reduce((n, v) => n + v.items, 0);

export default [
  { name: 'units-conserved', holds: (o) => stock(o).available + stock(o).reserved === 2 && stock(o).available >= 0 && stock(o).reserved >= 0 },
  { name: 'reserved-covers-paid', holds: (o) => stock(o).reserved >= paidUnits(o) },
  { name: 'charged-covers-paid', holds: (o) => pay(o).charged >= paidUnits(o) },
  { name: 'quiescent-reservations-are-exact', holds: (o, transit) => transit.length > 0 || stock(o).reserved === paidUnits(o) },
  { name: 'quiescent-charges-are-exact', holds: (o, transit) => transit.length > 0 || pay(o).charged === paidUnits(o) },
  { name: 'items-within-limit', holds: (o) => carts(o).every((v) => v.items >= 0 && v.items <= 2) },
];
