import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';

type Role = NodeView['role'];
type Vote = NodeView['votedFor'];

const MAX_TERM = 3;
const PEERS = ['n1', 'n2'];

const isTerm = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  let role: Role = 'follower';
  let term = 0;
  let votedFor: Vote = 'nobody';

  const host: Host = {
    async electionTimeout() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`no term after ${MAX_TERM}`);
      role = 'candidate';
      term = term + 1;
      votedFor = 'itself';
      return ok();
    },

    async electionWon() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can win an election');
      role = 'leader';
      return ok();
    },

    async newerTermSeen(seen: number) {
      if (role === 'shutdown') return refuse('node is shut down');
      if (!isTerm(seen)) return refuse(`term must be an integer from 1 to ${MAX_TERM}`);
      if (seen <= term) return refuse('term is not newer than the node\'s');
      role = 'follower';
      term = seen;
      votedFor = 'nobody';
      return ok();
    },

    async voteRequested(candidate: string, requested: number) {
      if (role === 'shutdown') return refuse('node is shut down');
      if (typeof candidate !== 'string' || !PEERS.includes(candidate)) {
        return refuse('candidate must be n1 or n2');
      }
      if (!isTerm(requested)) return refuse(`term must be an integer from 1 to ${MAX_TERM}`);
      const peer = candidate as Vote;
      if (requested > term) {
        role = 'follower';
        term = requested;
        votedFor = peer;
        return ok();
      }
      if (requested < term) return refuse('vote requested for an older term');
      if (role !== 'follower') return refuse('only a follower grants a vote in its own term');
      if (votedFor === peer) return ok();
      if (votedFor !== 'nobody') return refuse('already voted in this term');
      votedFor = peer;
      return ok();
    },

    async quorumLost() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role !== 'leader') return refuse('only the leader can lose its quorum');
      role = 'follower';
      return ok();
    },

    async shutdown() {
      if (role === 'shutdown') return refuse('node is already shut down');
      role = 'shutdown';
      return ok();
    },

    async node() {
      return { role, term };
    },
  };

  return host;
};

export default createHost;
