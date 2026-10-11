// plan-e3.md E3.3, HF3.5, S554: what a tool output becomes on its way to the model. The scan runs first. A flagged output
// is redacted before it is stored, archived or shown, the cheaper reader never sees it (no receipt is made for it), and
// the record the journal keeps holds its size, its hash and the kinds found, never its bytes. A clean output is archived
// as it is and, when it is over the log threshold, handed to the reader. The four sinks (the context, the archive, the
// reader's input and the journal record) are returned so that the canary test of S554 can scan each of them.
import { createHash } from 'node:crypto';
import { handleText } from './archive.mjs';
import { redact, scanText } from './scan.mjs';

/**
 * @param {{ output: string, secrets: string[], archive: { put(bytes: Buffer): string }, logBytes?: number, handleBytes?: number, excerptBytes?: number }} input
 * @returns {{ flagged: boolean, context: string, handleForm: string | null, archived: string, reader: string | null, journal: object }}
 */
export function intake({ output, secrets, archive, logBytes = 4096, handleBytes = 10240, excerptBytes = 512 }) {
  const scanned = scanText(output, secrets);
  const flagged = !scanned.clean;
  const safe = flagged ? redact(output, scanned.matches) : output;
  const archived = flagged ? safe : output; // @I-archive
  const id = archive.put(Buffer.from(archived, 'utf8'));
  const size = Buffer.byteLength(archived, 'utf8');
  return {
    flagged,
    // the first requests carry the output in full; the third replaces a large one by its handle (Observation, HF2.4)
    context: safe,
    handleForm: size > handleBytes ? handleText(id, archived, excerptBytes) : null,
    archived,
    reader: !flagged && size >= logBytes ? output : null,
    journal: {
      flagged,
      kinds: [...new Set(scanned.matches.map((m) => m.kind))],
      size,
      hash: `sha256:${createHash('sha256').update(archived).digest('hex')}`,
      handle: id,
    },
  };
}
