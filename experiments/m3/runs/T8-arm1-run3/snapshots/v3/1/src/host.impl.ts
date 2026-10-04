import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';

const MIN_TERM = 0;
const MAX_TERM = 3;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  let role: NodeView['role'] = 'follower';
  let term = MIN_TERM;
  let votedFor: NodeView['votedFor'] = 'nobody';
  let paused = false;

  const validTerm = (t: number) => typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

  const host: Host = {
    async electionTimeout() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`term ${MAX_TERM} is the last term`);
      role = 'candidate';
      term += 1;
      votedFor = 'itself';
      return ok();
    },
    async electionWon() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can win an election');
      role = 'leader';
      return ok();
    },
    async electionLost() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can lose an election');
      role = 'follower';
      return ok();
    },
    async newerTermSeen(t: number) {
      if (role === 'shutdown') return refuse('node is shut down');
      if (!validTerm(t)) return refuse(`term must be an integer from 1 to ${MAX_TERM}`);
      if (t <= term) return refuse('term is not newer');
      role = 'follower';
      term = t;
      votedFor = 'nobody';
      return ok();
    },
    async quorumLost() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role !== 'leader') return refuse('only the leader can lose quorum');
      role = 'follower';
      return ok();
    },
    async shutdown() {
      if (role === 'shutdown') return refuse('node is already shut down');
      role = 'shutdown';
      return ok();
    },
    async voteRequested(candidate: string, t: number) {
      if (role === 'shutdown') return refuse('node is shut down');
      if (candidate !== 'n1' && candidate !== 'n2') return refuse('candidate must be n1 or n2');
      if (!validTerm(t)) return refuse(`term must be an integer from 1 to ${MAX_TERM}`);
      if (t > term) {
        role = 'follower';
        term = t;
        votedFor = candidate;
        return ok();
      }
      if (t < term) return refuse('term is older than the node term');
      if (role !== 'follower') return refuse('only a follower grants its vote in its own term');
      if (votedFor !== 'nobody' && votedFor !== candidate) return refuse('already voted for another in this term');
      votedFor = candidate;
      return ok();
    },
    async node() {
      return { role, term, votedFor };
    },
  };
  return host;
};

export default createHost;
