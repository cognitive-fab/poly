// The host side of an inquiry (docs/examples/research-agents.md): it wires the planner to its two workers and asks the
// question. It holds no rule; the machines do. Typed against the generated types of the planner, so a wrong action or a wrong
// field is a finding of `poly check --host` (PL6836).
import type { Action, Content } from '../.poly/build/research.Planner/types.js';

interface Runtime {
  putContent(body: string): Promise<string>;
  dispatch<A>(id: string, action: A extends { action: infer N } ? N & string : string, data: A extends { data: infer D } ? D : unknown): Promise<unknown>;
}

/** Wires `planner` to its two workers, then asks the question. Returns the content id of the question. */
export async function startInquiry(rt: Runtime, o: { planner: string; workers: [string, string]; question: string }): Promise<string> {
  await rt.dispatch<Extract<Action, { action: 'Wire' }>>(o.planner, 'Wire', { a: o.workers[0], b: o.workers[1] });
  const question = await rt.putContent(o.question);
  await rt.dispatch<Extract<Action, { action: 'Ask' }>>(o.planner, 'Ask', { question: question as Content });
  return question;
}
