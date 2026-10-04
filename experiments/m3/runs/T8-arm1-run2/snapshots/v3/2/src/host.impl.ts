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
  let paused = false;

  return {
    async electionTimeout() {
      if (shutDown) return refuse('the node is shut down');
      if (role === 'leader') return refuse('the leader does not time out');
      if (paused) return refuse('the node is paused');
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
    async electionLost() {
      if (shutDown) return refuse('the node is shut down');
      if (role !== 'candidate') return refuse('only a candidate can lose an election');
      role = 'follower';
      return ok();
    },
    async newerTermSeen(t: number) {
      if (shutDown) return refuse('the node is shut down');
      if (!isTerm(t)) return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      if (t <= term) return refuse("the term is not newer than the node's term");
      role = 'follower';
      term = t;
      votedFor = 'nobody';
      return ok();
    },
    async voteRequested(candidate: string, t: number) {
      if (shutDown) return refuse('the node is shut down');
      if (!PEERS.includes(candidate)) return refuse('the candidate must be n1 or n2');
      if (!isTerm(t)) return refuse(`the term must be an integer from 1 to ${MAX_TERM}`);
      if (t > term) {
        role = 'follower';
        term = t;
        votedFor = candidate as Vote;
        return ok();
      }
      if (t < term) return refuse("the term is older than the node's term");
      if (role !== 'follower') return refuse('only a follower grants its vote in its own term');
      if (votedFor === candidate) return ok();
      if (votedFor !== 'nobody') return refuse('the node already voted in this term');
      votedFor = candidate as Vote;
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
      return { role: shutDown ? 'shutdown' : role, term, votedFor };
    },
  };
};

export default createHost;
