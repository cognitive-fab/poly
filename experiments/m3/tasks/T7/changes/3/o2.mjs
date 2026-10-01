// T7 O2 after change 3: the hidden invariants, over the observations of explore.json and the messages in transit (scoring only).
const run = (o) => Object.values(o.run)[0];
const worker = (o, w) => o.worker[JSON.stringify([w])];
const ended = (s) => ['completed', 'failed', 'cancelled'].includes(s);

export default [
  { name: 'processed-only-by-completed-tasks', holds: (o) => run(o).processed === 0 || run(o).task0 === 'completed' || run(o).task1 === 'completed' },
  { name: 'processed-within-bounds', holds: (o) => run(o).processed >= 0 && run(o).processed <= 4 },
  { name: 'completed-only-when-both-completed', holds: (o) => run(o).status !== 'completed' || (run(o).task0 === 'completed' && run(o).task1 === 'completed') },
  { name: 'ended-only-when-both-reported', holds: (o) => !ended(run(o).status) || (run(o).task0 !== 'assigned' && run(o).task1 !== 'assigned') },
  { name: 'failed-when-a-task-failed-and-both-reported', holds: (o) => !(run(o).task0 !== 'assigned' && run(o).task1 !== 'assigned' && (run(o).task0 === 'failed' || run(o).task1 === 'failed')) || run(o).status === 'failed' },
  { name: 'assigned-work-is-in-hand', holds: (o, transit) => transit.length > 0 || !['running', 'cancelling'].includes(run(o).status) || ['worker0', 'worker1'].every((w, i) => run(o)[`task${i}`] !== 'assigned' || worker(o, w)?.status === 'busy') },
];
