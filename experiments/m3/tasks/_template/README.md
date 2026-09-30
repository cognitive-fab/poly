# Task template (PT13, M3-1 to M3-5, S90 to S92)

Each task of the experiment is a directory `experiments/m3/tasks/<id>/` with the layout below. The column "seen by" says who may read each file. Nothing an arm sees names a state, a machine or a design choice beyond the observable behaviour.

| File | Content | Seen by |
|---|---|---|
| `task.json` | id, family, title, `multiMachine` (true or false), and the digests recorded at the freeze | the runner |
| `brief.md` | the feature in prose: what the host interface must do, observable behaviour only | every arm; the O1 session |
| `host.ts` | the host interface: a small TypeScript API, the same for every arm | every arm; the O1 session |
| `reference/` | the reference machine in poly, checked clean, with its own `host.map.json` | the controls only |
| `o2.mjs` | hidden invariants: predicates over the host interface's observable state | scoring only |
| `o3/` | reference traces: host calls with the observations expected after each, generated from the reference | scoring and controls |
| `mutant/` | the reference with one defect the brief rules out, and its `host.map.json` | the controls only |
| `changes/<n>/` | for n = 1, 2, 3: `brief.md` (the delta, in order), `host.ts` if the interface changes, and its own `reference/`, `o2.mjs`, `o3/` and `mutant/` (S92) | as above, per file |

## The host interface

`host.ts` exports one interface, `Host`, and one factory type, `CreateHost`, which every arm's module default-exports. A query returns plain JSON, or null for an id the host does not know. Every method and query returns a promise, in every arm: the poly arms' adapter reads polyrun's store, which is asynchronous, and the four arms implement one interface.

A multi-machine task (S91) adds the network API to `Host`, in the brief and for all four arms:

```ts
/** A message sent by one part of the system to another, not yet delivered. */
export interface Message { id: string; from: string; to: string; action: string; data: Record<string, unknown> }

export interface Network {
  /** Every message in transit, in no promised order. */
  inFlight(): Promise<Message[]>;
  /** Deliver one message in transit, by its id. */
  deliver(id: string): Promise<void>;
  /** Deliver every message in transit, and every message those deliveries send, until none is left. */
  deliverAll(): Promise<void>;
}
```

The brief of a multi-machine task says that messages may arrive in any order, and that nothing is delivered until `deliver` or `deliverAll` is called. O1 tests arrival orders only through this API.

## `host.map.json`, written by the poly arms (S90)

In arms 3 and 4 the agent writes `host.map.json` as part of its solution. It says which machine, which instance and which action each host method drives, and which fields each query reads. An instance is created with the host, or is one of a family a method creates, keyed by one of that method's arguments; a method or query on a family names the argument that keys it. The adapter generator (`experiments/m3/adapter/`) validates it against the host interface and the agent's poly module: a map that names a machine, an instance, an action, a parameter, an argument or a field that does not exist, or leaves a member of `Host` unmapped, is a failed build. Its schema is `host.map.schema.json`, given to the poly arms with the host interface. The task's own reference has its own map, which no arm sees.

## Evolution changes (S92)

Each change is delivered as a further turn of the same run, in order. Its `brief.md` is a delta against the brief as changed so far. Each change has its own reference, mutant, O2 and O3, and the independent O1 session writes one suite per version, receiving the change briefs in order and never a reference.

## Conclusion

A task is complete when every file above exists for the base version and the three changes, the reference checks clean, and the controls of `plan-m3.md` section 5 pass on every version.
