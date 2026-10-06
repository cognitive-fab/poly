// Witnesses.
//
// A denial is never a bare refusal. Every violation carries a witness: the
// obligation, the concrete bindings that falsified it, and — for sequence
// properties — the prior steps that, together with the proposal, form the
// violating sequence. The model re-plans around a reason.
import { summarizeAction } from './action.mjs';

const MAX_VAL = 160;

function short(v) {
  if (v === null || v === undefined) return 'null';
  let s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  if (s === undefined) s = String(v);
  return s.length > MAX_VAL ? s.slice(0, MAX_VAL - 1) + '…' : s;
}

/** Render one witness as plain text (what a PreToolUse denial reason contains). */
export function renderWitness(w) {
  const L = [];
  const sev = w.severity === 'warn' ? 'warning' : w.reason === 'escalate' ? 'escalated' : 'denied';
  L.push(`${sev}: ${w.obligation}${w.policy ? ` (${w.policy})` : ''} — ${w.text}`);
  switch (w.reason) {
    case 'require-failed': L.push(`  rule: ${w.expression}`); break;
    case 'escalate': L.push(`  rule: ${w.expression}`); L.push('  the gate cannot allow this on its own: a human must approve it (the host asks where it can; where it cannot, this is a refusal)'); break;
    case 'guard': L.push(`  machine '${w.obligation}' in state '${w.machine?.state ?? '?'}' forbids this: ${w.detail}`); if (w.expression) L.push(`  guard: ${w.expression}`); break;
    case 'invariant-failed': L.push(`  invariant: ${w.expression}`); break;
    case 'end-state-required': L.push(`  run cannot end: machine is in '${w.machine?.state ?? '?'}', accepted end states are ${(w.machine?.end ?? w.machine?.discharge ?? []).map((s) => `'${s}'`).join(', ')}`); break;
    case 'indeterminate': L.push(`  could not be established (unknown value): ${w.expression}`); break;
    case 'evaluation-error': L.push(`  evaluation error in ${w.expression}: ${w.detail}`); break;
    default: L.push(`  ${w.detail ?? w.reason}`);
  }
  if (w.bindings && Object.keys(w.bindings).length) {
    L.push('  bindings: ' + Object.entries(w.bindings).map(([k, v]) => `${k}=${short(v)}`).join(', '));
  }
  if (w.machine && w.machine.path && w.machine.path.length) {
    L.push('  how the machine got here:');
    for (const p of w.machine.path) L.push(`    step ${p.step}: ${summarizeAction(p.action)}  ${p.from} → ${p.to}`);
  }
  if (w.sequence && w.sequence.length) {
    L.push('  witness sequence:');
    for (const s of w.sequence) L.push(`    ${s.step === 'proposed' ? 'proposed' : 'step ' + s.step}: ${summarizeAction(s.action)}${s.note ? '  (' + s.note + ')' : ''}`);
  }
  if (w.hint) L.push(`  hint: ${w.hint}`);
  return L.join('\n');
}

/** Render a full verdict. */
export function renderVerdict(v) {
  const L = [];
  if (v.decision === 'allow') {
    L.push(`polyaxion: allow (step ${v.step}, ${v.checked} obligation${v.checked === 1 ? '' : 's'} checked${v.approved ? `; escalation lifted by ${v.approved.by}` : ''})`);
  } else if (v.decision === 'escalate') {
    L.push(`polyaxion: ESCALATE (step ${v.step}) — a human must approve this before it runs`);
    for (const w of v.witnesses) L.push(renderWitness(w));
    L.push('Nothing executed. If the host offers an approval, the user decides; otherwise treat this as a refusal and ask the user in words.');
  } else {
    L.push(`polyaxion: DENY (step ${v.step}) — ${v.witnesses.length} violation${v.witnesses.length === 1 ? '' : 's'}`);
    for (const w of v.witnesses) L.push(renderWitness(w));
    L.push('The effect did not execute. Re-plan around the reason above; recall the active obligations if unsure.');
  }
  for (const w of v.warnings ?? []) L.push(renderWitness(w));
  return L.join('\n');
}
