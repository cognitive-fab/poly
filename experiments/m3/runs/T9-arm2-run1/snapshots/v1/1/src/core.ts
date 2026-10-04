// The stateful core of the election: node states and the transition rules.
// Pure functions over plain data; the host owns the network and message ids.

export const NODES = ['n0', 'n1', 'n2'] as const;
export const ELECTION_TERM = 1;
export const MAJORITY = 2;

export type Role = 'follower' | 'candidate' | 'leader';

export interface NodeState {
  role: Role;
  term: number;
  votedFor: string | null;
  /** The leader this node knows in its term (itself, if it leads), or null. */
  leader: string | null;
  /** Ids of the nodes whose vote this node holds in its term (itself included). */
  votes: string[];
}

export interface Outgoing {
  from: string;
  to: string;
  action: 'RequestVote' | 'VoteReply' | 'Leader';
  data: Record<string, unknown>;
}

export function isNode(id: string): boolean {
  return (NODES as readonly string[]).includes(id);
}

export function initialNode(): NodeState {
  return { role: 'follower', term: 0, votedFor: null, leader: null, votes: [] };
}

const toOthers = (id: string, action: Outgoing['action']): Outgoing[] =>
  NODES.filter((n) => n !== id).map((to) => ({ from: id, to, action, data: { from: id, term: ELECTION_TERM } }));

export type TimeoutResult =
  | { ok: true; state: NodeState; send: Outgoing[] }
  | { ok: false; reason: string };

/** A follower in term 0 starts the (single) election of term 1. */
export function onTimeout(id: string, s: NodeState): TimeoutResult {
  if (s.role !== 'follower') return { ok: false, reason: `${id} is a ${s.role}, not a follower` };
  if (s.term !== 0) return { ok: false, reason: `${id} is already in term ${s.term}` };
  const state: NodeState = { role: 'candidate', term: ELECTION_TERM, votedFor: id, leader: null, votes: [id] };
  return { ok: true, state, send: toOthers(id, 'RequestVote') };
}

/** A node receives RequestVote; it always answers with a VoteReply. */
export function onRequestVote(
  id: string,
  s: NodeState,
  data: { from: string; term: number },
): { state: NodeState; send: Outgoing[] } {
  const candidate = data.from;
  let state = s;
  let granted = false;
  if (data.term === ELECTION_TERM && candidate !== id) {
    if (s.term < ELECTION_TERM) {
      state = { role: 'follower', term: ELECTION_TERM, votedFor: candidate, leader: null, votes: [] };
      granted = true;
    } else if (s.term === ELECTION_TERM) {
      if (s.role === 'follower' && s.votedFor === null) {
        state = { ...s, votedFor: candidate };
        granted = true;
      } else if (s.role === 'follower' && s.votedFor === candidate) {
        granted = true;
      }
    }
  }
  return {
    state,
    send: [{ from: id, to: candidate, action: 'VoteReply', data: { term: ELECTION_TERM, granted } }],
  };
}

/**
 * A candidate counts a granted reply for its term; anything else is ignored.
 * On reaching a majority it becomes the leader and announces itself.
 */
export function onVoteReply(
  id: string,
  s: NodeState,
  voter: string,
  data: { term: number; granted: boolean },
): { state: NodeState; send: Outgoing[] } {
  if (s.role !== 'candidate' || data.granted !== true || data.term !== s.term) return { state: s, send: [] };
  if (s.votes.includes(voter)) return { state: s, send: [] };
  const votes = [...s.votes, voter];
  if (votes.length < MAJORITY) return { state: { ...s, votes }, send: [] };
  return { state: { ...s, votes, role: 'leader', leader: id }, send: toOthers(id, 'Leader') };
}

/** A node learns the leader of term 1: a term-0 node joins term 1 without voting; a candidate steps down. */
export function onLeader(s: NodeState, data: { from: string; term: number }): NodeState {
  if (data.term !== ELECTION_TERM || s.role === 'leader') return s;
  if (s.term < ELECTION_TERM) {
    return { role: 'follower', term: ELECTION_TERM, votedFor: null, leader: data.from, votes: [] };
  }
  return { ...s, role: 'follower', leader: data.from };
}
