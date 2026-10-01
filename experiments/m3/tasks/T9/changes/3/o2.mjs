// T9 O2 after change 3: the hidden invariants, over the observations of explore.json (scoring only).
const IDS = ['n0', 'n1', 'n2'];
const node = (o, n) => o.node[JSON.stringify([n])];
const nodes = (o) => IDS.map((n) => ({ id: n, ...node(o, n) }));
const votesFor = (o, c) => nodes(o).filter((v) => v.term === node(o, c).term && v.votedFor === c).length;

export default [
  { name: 'one-leader-per-term', holds: (o) => { const l = nodes(o).filter((v) => v.role === 'leader'); return l.every((a, i) => l.every((b, j) => i === j || a.term !== b.term)); } },
  { name: 'leaders-hold-a-majority', holds: (o) => nodes(o).every((v) => v.role !== 'leader' || votesFor(o, v.id) >= 2) },
  { name: 'candidates-and-leaders-voted-for-themselves', holds: (o) => nodes(o).every((v) => v.role === 'follower' || v.role === 'down' || v.votedFor === v.id) },
  { name: 'voters-in-term-one-voted', holds: (o) => nodes(o).every((v) => v.term === 0 || v.votedFor !== null || v.leader !== null) },
  { name: 'no-vote-in-term-zero', holds: (o) => nodes(o).every((v) => v.term === 1 || v.votedFor === null) },
  { name: 'known-leaders-lead-or-crashed', holds: (o) => nodes(o).every((v) => v.leader === null || ['leader', 'down', 'follower'].includes(node(o, v.leader)?.role)) },
  { name: 'leaders-know-themselves', holds: (o) => nodes(o).every((v) => v.role !== 'leader' || v.leader === v.id) },
];
