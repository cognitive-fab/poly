// T7, a run and its workers: the run assigns both tasks, the workers report, and a cancel aborts what is still assigned.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, terminal, isIn,
  configuration, instance, implies, invariant,
} from '@cognitive-fab/poly/embed';

export default module('workflow', [
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
      processed: field(t.range(0, 4), () => 0),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.failed, $.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
      action('TaskTimeout', { task: t.range(0, 1) }),
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

      // A timed-out task fails for good (no retry) and its worker is aborted; its later report is ignored.
      on('TaskTimeout', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'run-not-active'),
        when($.task === 0, [
          require($.task0 === $.assigned, 'task-not-assigned'),
          set('task0', $.failed),
          send($.w0, 'Abort', {}),
          when($.task1 !== $.assigned, [set('status', $.failed)]),
        ], [
          require($.task1 === $.assigned, 'task-not-assigned'),
          set('task1', $.failed),
          send($.w1, 'Abort', {}),
          when($.task0 !== $.assigned, [set('status', $.failed)]),
        ]),
      ], ['task']),

      // A finished run ignores further reports, and a task reports once. The run's status follows once both
      // tasks have reported: completed if both completed, failed if any failed, cancelled otherwise.
      on('Report', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'run-not-active'),
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        when($.task === 0, [
          require($.task0 === $.assigned, 'task-already-reported'),
          // A first failure while running is retried: the task stays assigned and its worker is assigned again.
          when($.outcome === $.failed && $.status === $.running && !$.retried0, [
            set('retried0', true),
            send($.w0, 'Assign', {}),
          ], [
            set('task0', $.outcome),
            when($.outcome === $.completed, [set('processed', $.processed + $.items)]),
            when($.task1 !== $.assigned, [
              when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [
                when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)],
                  [set('status', $.cancelled)]),
              ]),
            ]),
          ]),
        ], [
          require($.task1 === $.assigned, 'task-already-reported'),
          when($.outcome === $.failed && $.status === $.running && !$.retried1, [
            set('retried1', true),
            send($.w1, 'Assign', {}),
          ], [
            set('task1', $.outcome),
            when($.outcome === $.completed, [set('processed', $.processed + $.items)]),
            when($.task0 !== $.assigned, [
              when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [
                when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)],
                  [set('status', $.cancelled)]),
              ]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome', 'items']),
    ],
  }),

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
      action('WorkDone', { items: t.int.check(0, 3, 'disclosed') }),
      action('WorkFailed', {}),

      on('Assign', ($) => [
        require($.status === $.idle, 'worker-busy'),
        set('status', $.busy),
      ]),
      // An Abort that reaches an idle worker is ignored: rejected, it changes nothing.
      on('Abort', ($) => [
        require($.status === $.busy, 'worker-idle'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.cancelled, items: 0 }),
      ]),
      on('WorkDone', ($) => [
        require($.status === $.busy, 'worker-not-busy'),
        require($.items >= 1 && $.items <= 2, 'items-not-1-or-2'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.completed, items: $.items }),
      ], ['items']),
      on('WorkFailed', ($) => [
        require($.status === $.busy, 'worker-not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.failed, items: 0 }),
      ]),
    ],
  }),

  configuration('one-run', {
    instances: [
      instance('run', 'Run', { init: ($) => ({ w0: $.worker0, w1: $.worker1 }) }),
      instance('worker0', 'Worker', { init: ($) => ({ task: 0, run: $.run }) }),
      instance('worker1', 'Worker', { init: ($) => ({ task: 1, run: $.run }) }),
    ],
    inputs: ['run.Start', 'run.Cancel', 'run.TaskTimeout','worker0.WorkDone', 'worker0.WorkFailed', 'worker1.WorkDone', 'worker1.WorkFailed'],
    bounds: { transit: 8 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === $.completed, $.run.task0 === $.completed && $.run.task1 === $.completed)),
      invariant('ends-only-when-both-reported', ($) =>
        implies(isIn($.run.status, [$.completed, $.failed, $.cancelled]),
          !isIn($.run.task0, [$.idle, $.assigned]) && !isIn($.run.task1, [$.idle, $.assigned]))),
      // A timed-out task is failed while its worker may still be busy, so only completion implies an idle worker.
      invariant('completed-task-has-idle-worker', ($) =>
        implies($.run.task0 === $.completed, $.worker0.status === $.idle) &&
        implies($.run.task1 === $.completed, $.worker1.status === $.idle)),
    ],
  }),
]);
