// T8, a consensus node's role and term: the implementation of the host interface.

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface NodeView {
  role: 'follower' | 'candidate' | 'leader' | 'shutdown';
  term: number;
}

export interface Host {
  electionTimeout(): Promise<Outcome>;
  electionWon(): Promise<Outcome>;
  newerTermSeen(term: number): Promise<Outcome>;
  quorumLost(): Promise<Outcome>;
  shutdown(): Promise<Outcome>;
  node(): Promise<NodeView>;
}

const MAX_TERM = 3;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost(): Promise<Host> {
  let role: NodeView['role'] = 'follower';
  let term = 0;

  return {
    async electionTimeout() {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`no term after ${MAX_TERM}`);
      role = 'candidate';
      term += 1;
      return ok();
    },
    async electionWon() {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can win an election');
      role = 'leader';
      return ok();
    },
    async newerTermSeen(newTerm: number) {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (typeof newTerm !== 'number' || !Number.isInteger(newTerm) || newTerm < 1 || newTerm > MAX_TERM) {
        return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      }
      if (newTerm <= term) return refuse('the term is not newer');
      role = 'follower';
      term = newTerm;
      return ok();
    },
    async quorumLost() {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (role !== 'leader') return refuse('only the leader can lose its quorum');
      role = 'follower';
      return ok();
    },
    async shutdown() {
      if (role === 'shutdown') return refuse('the node is already shut down');
      role = 'shutdown';
      return ok();
    },
    async node() {
      return { role, term };
    },
  };
}
