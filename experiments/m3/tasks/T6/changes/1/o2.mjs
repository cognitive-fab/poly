// T6 O2 after change 1: the hidden invariants, over the observations of explore.json (scoring only).
const jobs = (o) => Object.values(o.job).filter((v) => v !== null);

export default [
  { name: 'tries-within-limit', holds: (o) => jobs(o).every((v) => v.tries >= 0 && v.tries <= v.maxTries) },
  { name: 'failed-only-after-the-last-try', holds: (o) => jobs(o).every((v) => v.status !== 'failed' || v.tries === v.maxTries) },
  { name: 'queued-jobs-have-a-try-left', holds: (o) => jobs(o).every((v) => !['queued', 'held'].includes(v.status) || v.tries < v.maxTries) },
  { name: 'succeeded-was-tried', holds: (o) => jobs(o).every((v) => v.status !== 'succeeded' || v.tries >= 1) },
  { name: 'running-was-tried', holds: (o) => jobs(o).every((v) => !['running', 'cancelling'].includes(v.status) || v.tries >= 1) },
];
