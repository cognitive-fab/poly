// T5 O2 after change 3: the hidden invariants, over the observations of explore.json (scoring only).
const runs = (o) => Object.values(o.run).filter((v) => v !== null);
const tasks = (v) => [v.task0, v.task1, v.task2];
const inFlight = (s) => s === 'queued' || s === 'running' || s === 'evicted';

export default [
  { name: 'completed-only-when-every-task-completed', holds: (o) => runs(o).every((v) => v.status !== 'completed' || tasks(v).every((t) => t === 'completed')) },
  { name: 'failed-whenever-a-task-failed', holds: (o) => runs(o).every((v) => !tasks(v).includes('failed') || v.status === 'failed') },
  { name: 'final-only-when-nothing-in-flight', holds: (o) => runs(o).every((v) => !['completed', 'cancelled'].includes(v.status) || !tasks(v).some(inFlight)) },
  { name: 'uniform-tasks-give-their-status', holds: (o) => runs(o).every((v) => new Set(tasks(v)).size !== 1 || v.status === v.task0) },
  { name: 'running-means-mixed-and-in-flight', holds: (o) => runs(o).every((v) => v.status !== 'running' || tasks(v).some(inFlight) || tasks(v).every((t) => t === 'running')) },
];
