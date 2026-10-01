// T8 after change 3, a consensus node's role, term and vote, with lost elections and pauses: the host interface every arm implements (PT13).

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
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

/** The module's default export: a factory of a fresh system, with one node, a follower in term 0. */
export type CreateHost = () => Promise<Host>;
