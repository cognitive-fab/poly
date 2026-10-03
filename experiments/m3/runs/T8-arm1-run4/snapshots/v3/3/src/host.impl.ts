// T8, a consensus node's role and term: implementation of the host interface.

type Outcome = { ok: true } | { ok: false; reason: string };

type Role = 'follower' | 'candidate' | 'leader' | 'shutdown';

type Peer = 'n1' | 'n2';

type Vote = 'nobody' | 'itself' | Peer;

interface NodeView {
  role: Role;
  term: number;
  votedFor: Vote;
  paused: boolean;
}

interface Host {
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

const MIN_TERM = 0;
const MAX_TERM = 3;
const PEERS: readonly string[] = ['n1', 'n2'];

const isValidTerm = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost(): Promise<Host> {
  let role: Role = 'follower';
  let term = MIN_TERM;
  let votedFor: Vote = 'nobody';
  let paused = false;

  const isShutdown = () => role === 'shutdown';

  return {
    async electionTimeout() {
      if (isShutdown()) return refuse('the node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`no term after ${MAX_TERM}`);
      role = 'candidate';
      term += 1;
      votedFor = 'itself';
      return OK;
    },

    async electionWon() {
      if (isShutdown()) return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can win an election');
      role = 'leader';
      return OK;
    },

    async electionLost() {
      if (isShutdown()) return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can lose an election');
      role = 'follower';
      return OK;
    },

    async newerTermSeen(newTerm: number) {
      if (isShutdown()) return refuse('the node is shut down');
      if (!isValidTerm(newTerm)) return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      if (newTerm <= term) return refuse('the term is not newer than the node\'s term');
      role = 'follower';
      term = newTerm;
      votedFor = 'nobody';
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

    async voteRequested(candidate: string, reqTerm: number) {
      if (isShutdown()) return refuse('the node is shut down');
      if (typeof candidate !== 'string' || !PEERS.includes(candidate)) {
        return refuse('the candidate must be n1 or n2');
      }
      if (!isValidTerm(reqTerm)) return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      const peer = candidate as Peer;
      if (reqTerm > term) {
        role = 'follower';
        term = reqTerm;
        votedFor = peer;
        return OK;
      }
      if (reqTerm < term) return refuse('the request is from an older term');
      if (votedFor === peer) return OK;
      if (role !== 'follower') return refuse(`a ${role} does not grant its vote in its own term`);
      if (votedFor !== 'nobody') return refuse('the node has already voted in this term');
      votedFor = peer;
      return OK;
    },

    async node() {
      return { role, term, votedFor };
    },
  };
}
