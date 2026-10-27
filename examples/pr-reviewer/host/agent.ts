// The agent bridge of the PR reviewer (docs/examples/pr-reviewer.md). A workflow's effects are work orders: the agent takes
// each one, calls the tool the order names and reports. This bridge is that agent's side for the four tools the program
// asks for. It holds no rule: the gate has allowed the order before it is issued. It has no merge: an order for gh_merge,
// or any tool it does not know, is reported failed and calls nothing, so the tool the policy denies is also not here.
import type { Effects } from '../.poly/build/reviewer.Review/types.js';

type Verdict = Effects['github.label']['verdict'];

export interface Order {
  tool: string;
  kind?: string;
  args?: Record<string, unknown>;
}

export interface Github {
  diff(pr: number): string | Promise<string>;
  comment(pr: number, body: string): void | Promise<void>;
  label(pr: number, name: string): void | Promise<void>;
}

export interface Review {
  verdict: Verdict;
  comment: string;
  steps: number;
}

export interface Reviewer {
  review(pr: number, diff: string): Review | Promise<Review>;
}

export interface Deps {
  github: Github;
  reviewer: Reviewer;
}

export interface Report {
  ok: boolean;
  result: Record<string, unknown>;
  usage?: { step: number };
}

const STEP = 1000;
const FAILED: Report = { ok: false, result: {} };

// What the agent holds between the orders of a run: the diff it read and the review it wrote, by pull request. It is kept
// per GitHub client, which is the agent's session: a caller may build a new `deps` object for each order.
const held = new WeakMap<object, Map<number, { diff?: string; comment?: string }>>();
const memory = (deps: Deps): Map<number, { diff?: string; comment?: string }> => {
  let m = held.get(deps.github);
  if (!m) {
    m = new Map();
    held.set(deps.github, m);
  }
  return m;
};

export async function perform(order: Order, deps: Deps): Promise<Report> {
  const pr = Number(order.args?.pr);
  if (!Number.isInteger(pr)) return FAILED;
  const mine = memory(deps);
  try {
    switch (order.tool) {
      case 'gh_diff': {
        mine.set(pr, { ...mine.get(pr), diff: await deps.github.diff(pr) });
        return { ok: true, result: {}, usage: { step: STEP } };
      }
      case 'reviewer': {
        const diff = mine.get(pr)?.diff;
        if (diff === undefined) return FAILED;
        const r = await deps.reviewer.review(pr, diff);
        mine.set(pr, { ...mine.get(pr), comment: r.comment });
        return { ok: true, result: { verdict: r.verdict }, usage: { step: r.steps } };
      }
      case 'gh_comment': {
        const comment = mine.get(pr)?.comment;
        if (comment === undefined) return FAILED;
        await deps.github.comment(pr, comment);
        return { ok: true, result: {}, usage: { step: STEP } };
      }
      case 'gh_label': {
        const verdict = order.args?.verdict;
        if (verdict !== 'Good' && verdict !== 'Bad') return FAILED;
        await deps.github.label(pr, verdict === 'Good' ? 'lgtm' : 'needs-work');
        return { ok: true, result: {}, usage: { step: STEP } };
      }
      default:
        // gh_merge among them: the bridge has no merge.
        return FAILED;
    }
  } catch {
    return FAILED;
  }
}
