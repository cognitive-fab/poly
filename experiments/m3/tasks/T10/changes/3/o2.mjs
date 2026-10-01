// T10 O2 after change 3: the hidden invariants, over the observations of explore.json and the messages in transit (scoring only).
const lease = (o) => Object.values(o.lease)[0];
const client = (o, c) => o.client[JSON.stringify([c])];
const clients = (o) => ['c0', 'c1'].map((c) => ({ id: c, ...client(o, c) }));

export default [
  { name: 'tokens-and-writes-within-bounds', holds: (o) => lease(o).token >= 0 && lease(o).token <= 2 && lease(o).writes >= 0 && lease(o).writes <= 2 },
  { name: 'one-holder-with-the-current-token', holds: (o) => clients(o).filter((c) => c.status === 'holding' && c.token === lease(o).token).length <= 1 },
  { name: 'quiescent-holder-was-granted-the-current-token', holds: (o, transit) => transit.length > 0 || lease(o).holder === null || client(o, lease(o).holder).token === lease(o).token },
  { name: 'at-most-one-write-per-grant', holds: (o) => lease(o).writes <= lease(o).token },
  { name: 'client-tokens-were-granted', holds: (o) => clients(o).every((c) => c.token <= lease(o).token) },
  { name: 'quiescent-holders-agree', holds: (o, transit) => transit.length > 0 || clients(o).every((c) => (c.status === 'holding') === (lease(o).holder === c.id)) },
  { name: 'quiescent-releases-are-acknowledged', holds: (o, transit) => transit.length > 0 || clients(o).every((c) => c.status !== 'releasing') },
];
