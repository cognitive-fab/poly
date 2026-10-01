// T8 O2: the hidden invariants, over the observations of explore.json (scoring only).
const node = (o) => Object.values(o.node)[0];

export default [
  { name: 'term-within-bounds', holds: (o) => node(o).term >= 0 && node(o).term <= 3 },
  { name: 'leaders-were-elected', holds: (o) => node(o).role !== 'leader' || node(o).term >= 1 },
  { name: 'candidates-started-an-election', holds: (o) => node(o).role !== 'candidate' || node(o).term >= 1 },
  { name: 'known-role', holds: (o) => ['follower', 'candidate', 'leader', 'shutdown'].includes(node(o).role) },
];
