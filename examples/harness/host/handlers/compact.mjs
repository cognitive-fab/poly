// plan-e3.md E3.3, HF2.3, HF3.3, S561: the application of a compaction. The summary decision wrote the summary; this
// replaces the old transcript with the pinned messages, the summary and the last few messages, and it
//   - refuses a result that is not smaller than the transcript it replaces (S561: a compaction shrinks the window);
//   - keeps every pinned message (the system prompt, the task, the current plan step);
//   - keeps a reference for every archive handle that the new transcript still mentions, and releases the others
//     (HF3.3: an archived output stays available while any context refers to it).
// The size is in characters here; the host reports it in buckets (assumption "token-buckets").
import { handlesIn } from './archive.mjs';

const sizeOf = (messages) => messages.reduce((n, m) => n + m.text.length, 0);

/**
 * @param {{ transcript: { role: string, text: string, pinned?: boolean }[], summary: string, keepLast: number, archive: { release(id: string): void } }} input
 * @returns {{ transcript: object[], before: number, after: number, released: string[] }}
 */
export function applyCompaction({ transcript, summary, keepLast, archive }) {
  const before = sizeOf(transcript);
  const tailFrom = Math.max(0, transcript.length - keepLast);
  const kept = transcript.filter((m, i) => m.pinned || i >= tailFrom);
  const next = [...kept.filter((m) => m.pinned), { role: 'summary', text: summary }, ...kept.filter((m) => !m.pinned)];
  const after = sizeOf(next);
  if (after >= before) throw Object.assign(new Error(`the compaction does not shrink the transcript (${after} of ${before})`), { permanent: true });
  const still = new Set(next.flatMap((m) => handlesIn(m.text)));
  const gone = [...new Set(transcript.filter((m) => !kept.includes(m)).flatMap((m) => handlesIn(m.text)))].filter((id) => !still.has(id));
  for (const id of gone) archive.release(id);
  return { transcript: next, before, after, released: gone };
}
