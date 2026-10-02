// The OutboxIntent builds, lowered in memory: shared by the build script and the CI test that compares them with
// the checked-in bytes. Writes nothing.
import { createHash } from 'node:crypto';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { modelSource, machineOfBound, BOUNDS, MODEL_FILES } from '@poly/runtime/model';

export function lowerModels() {
  const files = {};
  const manifest = {};
  for (const m of BOUNDS) {
    const r = parse(modelSource(m));
    if (!r.module || r.diagnostics.length) throw new Error(`OutboxIntent for ${m}: ${r.diagnostics.map((d) => d.message).join('; ')}`);
    const check = checkModule(r.module);
    if (check.diagnostics.length) throw new Error(`OutboxIntent for ${m}: ${check.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`);
    const { lowered, diagnostics } = lowerMachine(r.module, check, 'OutboxIntent');
    if (!lowered) throw new Error(`OutboxIntent for ${m}: ${diagnostics.map((d) => d.message).join('; ')}`);
    for (const f of MODEL_FILES) {
      const text = lowered.files[f];
      if (text === undefined) throw new Error(`OutboxIntent for ${m}: the lowering wrote no ${f}`);
      const rel = `${machineOfBound(m)}/${f}`;
      files[rel] = text;
      manifest[rel] = 'sha256:' + createHash('sha256').update(text).digest('hex');
    }
  }
  return { files, manifest };
}
