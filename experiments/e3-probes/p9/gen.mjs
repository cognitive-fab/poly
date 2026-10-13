// E3.4 gate item: the joint configuration of the harness's machines. Usage: node gen.mjs <pair> <transit>
//   trialctx  Trial and Context (Trial to Context: StepFinished, StepReset; Context to Trial: OverflowEnd)
//   turntrial Turn and Trial    (Turn to Trial: Stored, Faulted, BudgetStop)
import { readFileSync, writeFileSync } from 'node:fs';
const [pair, transit] = [process.argv[2], process.argv[3] ?? '3'];
const src = readFileSync(new URL('../../../examples/harness/harness.poly', import.meta.url), 'utf8').replace(/^\/\/ expected: CLEAN\n/, '');
const cfg = {
  trialctx: `
configuration trialctx {
  c  : Context { trial: tr }
  tr : Trial { context: c }
  inputs { tr.Begin, tr.Stored, tr.StagePassed, tr.StageFailed, tr.NextStep, c.Grew, c.Overflowed, c.Measured, c.Summarised, c.Compacted, c.CompactFailed, c.SummaryFailed }
  bounds { transit ${transit} }
}
`,
  turntrial: `
configuration turntrial {
  tr : Trial { context: c }
  c  : Context { trial: tr }
  t  : Turn { trial: tr, ledger: l }
  l  : Ledger { obs: o }
  o  : Observation { arch: a }
  a  : Archive
  inputs { t.Start, t.Metered, t.Stepped, t.StepFailed, t.Fusable, t.Separate, t.Reprompt, t.Go, t.Ran, t.Clean, t.Flagged, t.StoreLog, t.Logged, t.Fault, tr.Begin, tr.NextStep, tr.StagePassed, tr.StageFailed, tr.Close }
  bounds { transit ${transit} }
}
`,
}[pair];
writeFileSync(new URL(`./${pair}.poly`, import.meta.url), src + cfg);
