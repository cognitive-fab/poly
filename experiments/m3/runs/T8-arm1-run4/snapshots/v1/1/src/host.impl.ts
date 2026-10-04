// T8, a consensus node's role and term: implementation of the host interface.

type Outcome = { ok: true } | { ok: false; reason: string };

type Role = 'follower' | 'candidate' | 'leader' | 'shutdown';

type Peer = 'n1' | 'n2';

type Vote = 'nobody' | 'itself' | Peer;

interface NodeView {
  role: Role;
  term: number;
  votedFor: Vote;
}

interface Host {
  electionTimeout(): Promise<Outcome>;
  electionWon(): Promise<Outcome>;
  newerTermSeen(term: number): Promise<Outcome>;
  quorumLost(): Promise<Outcome>;
  shutdown(): Promise<Outcome>;
  node(): Promise<NodeView>;
}

const MIN_TERM = 0;
const MAX_TERM = 3;

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost(): Promise<Host> {
  let role: Role = 'follower';
  let term = MIN_TERM;

  const isShutdown = () => role === 'shutdown';

  return {
    async electionTimeout() {
      if (isShutdown()) return refuse('the node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`no term after ${MAX_TERM}`);
      role = 'candidate';
      term += 1;
      return OK;
    },

    async electionWon() {
      if (isShutdown()) return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can win an election');
      role = 'leader';
      return OK;
    },

    async newerTermSeen(newTerm: number) {
      if (isShutdown()) return refuse('the node is shut down');
      if (typeof newTerm !== 'number' || !Number.isInteger(newTerm) || newTerm < 1 || newTerm > MAX_TERM) {
        return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      }
      if (newTerm <= term) return refuse('the term is not newer than the node\'s term');
      role = 'follower';
      term = newTerm;
      return OK;
    },

    async quorumLost() {
      if (isShutdown()) return refuse('the node is shut down');
      if (role !== 'leader') return refuse('only the leader can lose its quorum');
      role = 'follower';
      return OK;
    },

    async shutdown() {
      if (isShutdown()) return refuse('the node is already shut down');
      role = 'shutdown';
      return OK;
    },

    async node() {
      return { role, term };
    },
  };
}
