// The stateful core of the election: node states and the transition rules.
// Pure functions over plain data; the host owns the network and message ids.

export const NODES = ['n0', 'n1', 'n2'] as const;
export const ELECTION_TERM = 1;
export const MAJORITY = 2;

export type Role = 'follower' | 'candidate' | 'leader' | 'down';

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

export type GiveUpResult = { ok: true; state: NodeState } | { ok: false; reason: string };

/** A candidate gives up: a follower in the same term, still voted for itself, counting no more votes. */
export function onGiveUp(id: string, s: NodeState): GiveUpResult {
  if (s.role !== 'candidate') return { ok: false, reason: `${id} is a ${s.role}, not a candidate` };
  return { ok: true, state: { ...s, role: 'follower', votes: [] } };
}

export type CrashResult = { ok: true; state: NodeState } | { ok: false; reason: string };

/** A node goes down: its term, vote and known leader survive; the votes it was counting do not. */
export function onCrash(id: string, s: NodeState): CrashResult {
  if (s.role === 'down') return { ok: false, reason: `${id} is already down` };
  return { ok: true, state: { ...s, role: 'down', votes: [] } };
}

/** A down node comes back as a follower in the same term, with the same vote and known leader. */
export function onRecover(id: string, s: NodeState): CrashResult {
  if (s.role !== 'down') return { ok: false, reason: `${id} is not down` };
  return { ok: true, state: { ...s, role: 'follower', votes: [] } };
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
  // a candidate steps down: it keeps its vote, and counts no more votes
  return { ...s, role: 'follower', leader: data.from, votes: [] };
}
