// T8, a consensus node's role, term and vote: the implementation of the host interface.

export type Outcome = { ok: true } | { ok: false; reason: string };

export interface NodeView {
  role: 'follower' | 'candidate' | 'leader' | 'shutdown';
  term: number;
  votedFor: 'nobody' | 'itself' | 'n1' | 'n2';
  paused: boolean;
}

export interface Host {
  electionTimeout(): Promise<Outcome>;
  electionWon(): Promise<Outcome>;
  electionLost(): Promise<Outcome>;
  newerTermSeen(term: number): Promise<Outcome>;
  quorumLost(): Promise<Outcome>;
  shutdown(): Promise<Outcome>;
  pause(): Promise<Outcome>;
  resume(): Promise<Outcome>;
  voteRequested(candidate: string, term: number): Promise<Outcome>;
  node(): Promise<NodeView>;
}

const MAX_TERM = 3;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const isValidTerm = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

export default async function createHost(): Promise<Host> {
  let role: NodeView['role'] = 'follower';
  let term = 0;
  let votedFor: NodeView['votedFor'] = 'nobody';
  let paused = false;

  return {
    async electionTimeout() {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`no term after ${MAX_TERM}`);
      role = 'candidate';
      term += 1;
      votedFor = 'itself';
      return ok();
    },
    async electionWon() {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can win an election');
      role = 'leader';
      return ok();
    },
    async electionLost() {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can lose an election');
      role = 'follower';
      return ok();
    },
    async newerTermSeen(newTerm: number) {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (!isValidTerm(newTerm)) return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      if (newTerm <= term) return refuse('the term is not newer');
      role = 'follower';
      term = newTerm;
      votedFor = 'nobody';
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
    async voteRequested(candidate: string, reqTerm: number) {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (candidate !== 'n1' && candidate !== 'n2') return refuse('the candidate must be n1 or n2');
      if (!isValidTerm(reqTerm)) return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      if (reqTerm < term) return refuse("the term is older than the node's term");
      if (reqTerm > term) {
        role = 'follower';
        term = reqTerm;
        votedFor = candidate;
        return ok();
      }
      if (role !== 'follower') return refuse('only a follower grants its vote in its own term');
      if (votedFor !== 'nobody' && votedFor !== candidate) return refuse('the node has already voted in this term');
      votedFor = candidate;
      return ok();
    },
    async node() {
      return { role, term, votedFor };
    },
  };
}
