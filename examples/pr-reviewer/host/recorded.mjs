// The recorded GitHub and the recorded reviewing agent of the PR reviewer (docs/examples/pr-reviewer.md). No model is
// called and no repository is read: each pull request's diff, verdict, comment and cost in steps are in
// recorded/answers.json, and every call is kept. A pull request the fixture does not hold throws.
import { readFileSync } from 'node:fs';

/** The fixture of recorded pull requests. */
export function loadAnswers(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f || !Array.isArray(f.prs)) throw new Error(`${file}: not a recorded-answers fixture`);
  return f;
}

const find = (fixture, number) => {
  const pr = fixture.prs.find((x) => x.number === number);
  if (!pr) throw new Error(`no recorded pull request ${number}`);
  return pr;
};

/** A GitHub that answers diffs from the fixture and keeps each call as { method, number, ... }. */
export function recordedGithub(fixture) {
  const calls = [];
  const github = {
    async diff(number) { calls.push({ method: 'diff', number }); return find(fixture, number).diff; },
    async comment(number, body) { find(fixture, number); calls.push({ method: 'comment', number, body }); },
    async label(number, name) { find(fixture, number); calls.push({ method: 'label', number, name }); },
  };
  return { calls, github };
}

/** The reviewing agent: `asked` keeps the number of each pull request it reviewed, never the diff. */
export function recordedAgent(fixture) {
  const asked = [];
  const reviewer = {
    async review(number) {
      const pr = find(fixture, number);
      asked.push({ number });
      return { verdict: pr.verdict, comment: pr.comment, steps: pr.steps };
    },
  };
  return { asked, reviewer };
}
