import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';

const MIN_TERM = 0;
const MAX_TERM = 3;

type Role = NodeView['role'];

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  let role: Role = 'follower';
  let term = MIN_TERM;

  const host: Host = {
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

    async newerTermSeen(t: number) {
      if (role === 'shutdown') return refuse('the node is shut down');
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TERM) {
        return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      }
      if (t <= term) return refuse('the term is not newer than the node\'s term');
      role = 'follower';
      term = t;
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

  return host;
};

export default createHost;
