// The sources whose whole-pipeline checks run in the serial after-suite group (test/after/), not beside the parallel
// suite, as ruled on 2026-10-10: the concierge example's toolchain-fault check took 434 s and its translation
// validation 210 s, about eleven minutes added to the parallel suite. They stay in the standing rule's coverage
// (test/standing.test.mjs); only where their checks run moves. A path is a directory from the repository root.
// The inbox joins the concierge (ruled 2026-10-10): its check takes about two minutes and up to 8 GB.
import { relative, sep } from 'node:path';
import { ROOT } from './helpers.mjs';

// The demo copy of the concierge (Step 9) is the concierge with two cap lines changed, and its check is as long.
export const SERIAL = ['examples/concierge/', 'examples/inbox/', 'demo/concierge/'];

/** Whether a source is checked in the serial group. */
export const serial = (file) => SERIAL.some((d) => (relative(ROOT, file).split(sep).join('/') + '/').startsWith(d));
