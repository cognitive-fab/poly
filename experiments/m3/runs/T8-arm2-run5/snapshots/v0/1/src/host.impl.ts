import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';

type Role = NodeView['role'];

const MAX_TERM = 3;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  let role: Role = 'follower';
  let term = 0;

  const host: Host = {
    async electionTimeout() {
      if (role === 'shutdown') return refuse('node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`no term after ${MAX_TERM}`);
      role = 'candidate';
      term = term + 1;
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
      if (typeof seen !== 'number' || !Number.isInteger(seen) || seen < 1 || seen > MAX_TERM) {
        return refuse(`term must be an integer from 1 to ${MAX_TERM}`);
      }
      if (seen <= term) return refuse('term is not newer than the node\'s');
      role = 'follower';
      term = seen;
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
