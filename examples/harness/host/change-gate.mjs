// HF3.11 and S557 (plan-e3.md): a change to the harness may touch only its editable surface (skills, prompts and
// thresholds under editable/). The rules (harness.poly), the signed policy (harness.policy.poly), the price tables, this
// gate and every other file are out of reach of the loop they govern. The gate is deterministic and reads no model.
// A threshold here is a size that moves the cost and never a rule: the rules are properties of the module, which a
// change cannot reach, so every threshold value keeps them (README, "What may change").
import { posix } from 'node:path';

const SURFACE = [
  /^editable\/prompts\/[^/]+\.md$/,
  /^editable\/skills\/[^/]+\.md$/,
  /^editable\/thresholds\.json$/,
];

/** Why a path is outside the surface, or null when it is inside. */
function refusal(file) {
  if (typeof file !== 'string' || file.length === 0) return 'not a path';
  if (file.includes(String.fromCharCode(92))) return 'a backslash in a path (paths are written with /)';
  if (file.split('/').includes('..')) return 'a path that climbs out of its folder';
  if (posix.isAbsolute(file)) return 'an absolute path';
  if (posix.normalize(file) !== file) return 'a path that is not in normal form';
  return SURFACE.some((re) => re.test(file)) ? null : 'outside the editable surface (editable/prompts, editable/skills, editable/thresholds.json)';
}

/**
 * @param {{ root: string, changed: string[] }} change the files a proposed change touches, relative to the example's root
 * @returns {{ accepted: boolean, refused: { file: string, reason: string }[] }}
 */
export function checkChange({ changed }) {
  const refused = [];
  for (const file of changed) {
    const reason = refusal(file);
    if (reason) refused.push({ file, reason });
  }
  return { accepted: refused.length === 0, refused };
}
