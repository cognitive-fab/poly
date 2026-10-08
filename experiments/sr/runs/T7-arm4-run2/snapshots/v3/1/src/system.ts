// A run and its two workers (T7): the run assigns task 0 to worker0 and task 1 to worker1, and the workers
// report each task's outcome back. The run and the workers talk only by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, isIn, terminal, implies,
  invariant, configuration, instance,
} from '@cognitive-fab/poly/embed';

export default module('runs', [
  enumType('RunStatus', ['idle', 'running', 'cancelling', 'completed', 'failed', 'cancelled']),
  enumType('TaskStatus', ['idle', 'assigned', 'completed', 'failed', 'cancelled']),
  enumType('WorkerStatus', ['idle', 'busy']),
  machine('Run', {
    state: {
      status: field(t.named('RunStatus'), ($) => $.idle),
      task0: field(t.named('TaskStatus'), ($) => $.idle),
      task1: field(t.named('TaskStatus'), ($) => $.idle),
      retried0: field(t.bool, () => false),
      retried1: field(t.bool, () => false),
      // The items processed by the completed tasks: at most 2 per task.
      processed: field(t.range(0, 4), () => 0),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.failed, $.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
      action('Timeout', { task: t.range(0, 1) }),
      action('Report', { task: t.range(0, 1), outcome: t.named('TaskStatus'), items: t.range(0, 2) }),
      on('Start', ($) => [
        require($.status === $.idle, 'already-started'),
        set('status', $.running),
        set('task0', $.assigned),
        set('task1', $.assigned),
        send($.w0, 'Assign', {}),
        send($.w1, 'Assign', {}),
      ]),
      on('Cancel', ($) => [
        require($.status === $.running, 'not-running'),
        set('status', $.cancelling),
        when($.task0 === $.assigned, [send($.w0, 'Abort', {})]),
        when($.task1 === $.assigned, [send($.w1, 'Abort', {})]),
      ]),
      // A timeout records the task as failed for the last time (no retry) and aborts its worker; a report
      // that arrives later for the task is ignored, since the task is no longer assigned.
      on('Timeout', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'not-running'),
        when($.task === 0, [
          require($.task0 === $.assigned, 'not-assigned'),
          set('task0', $.failed),
          send($.w0, 'Abort', {}),
          when($.task1 !== $.assigned, [set('status', $.failed)]),
        ], [
          require($.task1 === $.assigned, 'not-assigned'),
          set('task1', $.failed),
          send($.w1, 'Abort', {}),
          when($.task0 !== $.assigned, [set('status', $.failed)]),
        ]),
      ], ['task']),
      // A report is recorded only while the run is running or cancelling and its task has not reported;
      // otherwise it is ignored (an observable rejection). Once both tasks have reported, the run ends.
      on('Report', ($) => [
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        require(isIn($.status, [$.running, $.cancelling]), 'run-ended'),
        // A task's first failure while the run is running is retried once: its worker is assigned it again.
        when($.task === 0, [
          require($.task0 === $.assigned, 'already-reported'),
          when($.outcome === $.failed && $.status === $.running && !$.retried0, [
            set('retried0', true),
            send($.w0, 'Assign', {}),
          ], [
            set('task0', $.outcome),
            when($.outcome === $.completed, [set('processed', $.processed + $.items)]),
            when($.task1 !== $.assigned, [
              when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [
                when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)], [set('status', $.cancelled)]),
              ]),
            ]),
          ]),
        ], [
          require($.task1 === $.assigned, 'already-reported'),
          when($.outcome === $.failed && $.status === $.running && !$.retried1, [
            set('retried1', true),
            send($.w1, 'Assign', {}),
          ], [
            set('task1', $.outcome),
            when($.outcome === $.completed, [set('processed', $.processed + $.items)]),
            when($.task0 !== $.assigned, [
              when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [
                when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)], [set('status', $.cancelled)]),
              ]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome', 'items']),
      invariant('completed-when-both-completed', ($) => implies($.status === $.completed, $.task0 === $.completed && $.task1 === $.completed)),
      invariant('ended-when-both-reported', ($) => implies(isIn($.status, [$.completed, $.failed, $.cancelled]),
        isIn($.task0, [$.completed, $.failed, $.cancelled]) && isIn($.task1, [$.completed, $.failed, $.cancelled]))),
    ],
  }),
  // A worker serves its run for the life of the system, so it has no terminal state.
  machine('Worker', {
    service: true,
    state: {
      status: field(t.named('WorkerStatus'), ($) => $.idle),
      task: field(t.range(0, 1), () => 0),
      run: field(t.ref('Run'), ($) => $.none),
    },
    items: [
      action('Assign', {}),
      action('Abort', {}),
      action('Done', { items: t.range(1, 2) }),
      action('Fail', {}),
      on('Assign', ($) => [require($.status === $.idle, 'busy'), set('status', $.busy)]),
      // An Abort that reaches an idle worker is ignored (an observable rejection).
      on('Abort', ($) => [
        require($.status === $.busy, 'idle-ignores-abort'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.cancelled, items: 0 }),
      ]),
      on('Done', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.completed, items: $.items }),
      ]),
      on('Fail', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.failed, items: 0 }),
      ]),
    ],
  }),
  configuration('system', {
    instances: [
      instance('run', 'Run', { init: ($) => ({ w0: $.worker0, w1: $.worker1 }) }),
      instance('worker0', 'Worker', { init: ($) => ({ task: 0, run: $.run }) }),
      instance('worker1', 'Worker', { init: ($) => ({ task: 1, run: $.run }) }),
    ],
    inputs: ['run.Start', 'run.Cancel', 'run.Timeout','worker0.Done', 'worker0.Fail', 'worker1.Done', 'worker1.Fail'],
    bounds: { transit: 8 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === $.completed, $.run.task0 === $.completed && $.run.task1 === $.completed)),
    ],
  }),
]);
