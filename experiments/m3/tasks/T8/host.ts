// T8, a consensus node's role and term: the host interface every arm implements (PT13).

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export interface NodeView {
  role: 'follower' | 'candidate' | 'leader' | 'shutdown';
  term: number;
}

export interface Host {
  electionTimeout(): Promise<Outcome>;
  electionWon(): Promise<Outcome>;
  newerTermSeen(term: number): Promise<Outcome>;
  quorumLost(): Promise<Outcome>;
  shutdown(): Promise<Outcome>;
  node(): Promise<NodeView>;
}

/** The module's default export: a factory of a fresh system, with one node, a follower in term 0. */
export type CreateHost = () => Promise<Host>;
