import type { CreateHost, Host, NodeView, Outcome } from '../host.ts';

const MAX_TERM = 3;

type Role = 'follower' | 'candidate' | 'leader';
type Vote = NodeView['votedFor'];

const PEERS = ['n1', 'n2'];

const isTerm = (t: unknown): t is number =>
  typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= MAX_TERM;

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async (): Promise<Host> => {
  let role: Role = 'follower';
  let term = 0;
  let shutDown = false;
  let votedFor: Vote = 'nobody';

  return {
    async electionTimeout() {
      if (shutDown) return refuse('the node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (term >= MAX_TERM) return refuse(`no term after ${MAX_TERM}`);
      role = 'candidate';
      term += 1;
      votedFor = 'itself';
      return ok();
    },
    async electionWon() {
      if (shutDown) return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can win an election');
      role = 'leader';
      return ok();
    },
    async newerTermSeen(t: number) {
      if (shutDown) return refuse('the node is shut down');
      if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TERM) {
        return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      }
      if (t <= term) return refuse("the term is not newer than the node's term");
      role = 'follower';
      term = t;
      return ok();
    },
    async quorumLost() {
      if (shutDown) return refuse('the node is shut down');
      if (role !== 'leader') return refuse('only the leader can lose its quorum');
      role = 'follower';
      return ok();
    },
    async shutdown() {
      if (shutDown) return refuse('the node is already shut down');
      shutDown = true;
      return ok();
    },
    async node(): Promise<NodeView> {
      return { role: shutDown ? 'shutdown' : role, term };
    },
  };
};

export default createHost;
