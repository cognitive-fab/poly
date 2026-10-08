// T7, a run and its workers: the run and each worker are separate machines that talk only by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, terminal, isIn, implies,
  configuration, instance, invariant,
} from '@cognitive-fab/poly/embed';

export default module('runs', [
  enumType('RunStatus', ['idle', 'running', 'cancelling', 'completed', 'failed', 'cancelled']),
  enumType('TaskStatus', ['idle', 'assigned', 'completed', 'failed', 'cancelled']),
  enumType('WorkerStatus', ['idle', 'busy']),

  machine('Run', {
    state: {
      status: field(t.named('RunStatus'), ($) => $.RunStatus.idle),
      task0: field(t.named('TaskStatus'), ($) => $.TaskStatus.idle),
      task1: field(t.named('TaskStatus'), ($) => $.TaskStatus.idle),
      retried0: field(t.bool, () => false),
      retried1: field(t.bool, () => false),
      processed: field(t.range(0, 4), () => 0),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.RunStatus.completed, $.RunStatus.failed, $.RunStatus.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
      action('Timeout', { task: t.range(0, 1) }),
      action('Report', { task: t.range(0, 1), outcome: t.named('TaskStatus'), items: t.range(0, 2) }),

      on('Start', ($) => [
        require($.status === $.RunStatus.idle, 'already-started'),
        set('status', $.RunStatus.running),
        set('task0', $.TaskStatus.assigned),
        set('task1', $.TaskStatus.assigned),
        send($.w0, 'Assign', {}),
        send($.w1, 'Assign', {}),
      ]),

      on('Cancel', ($) => [
        require($.status === $.RunStatus.running, 'not-running'),
        set('status', $.RunStatus.cancelling),
        when($.task0 === $.TaskStatus.assigned, [send($.w0, 'Abort', {})]),
        when($.task1 === $.TaskStatus.assigned, [send($.w1, 'Abort', {})]),
      ]),

      // A timeout records the task as failed for the last time (no retry) and aborts its worker.
      on('Timeout', ($) => [
        require(isIn($.status, [$.RunStatus.running, $.RunStatus.cancelling]), 'run-not-active'),
        when($.task === 0, [
          require($.task0 === $.TaskStatus.assigned, 'not-assigned'),
          set('task0', $.TaskStatus.failed),
          send($.w0, 'Abort', {}),
          when($.task1 !== $.TaskStatus.assigned, [set('status', $.RunStatus.failed)]),
        ], [
          require($.task1 === $.TaskStatus.assigned, 'not-assigned'),
          set('task1', $.TaskStatus.failed),
          send($.w1, 'Abort', {}),
          when($.task0 !== $.TaskStatus.assigned, [set('status', $.RunStatus.failed)]),
        ]),
      ], ['task']),

      // A report records the task's outcome; the run ends only once both tasks have reported.
      on('Report', ($) => [
        require(isIn($.status, [$.RunStatus.running, $.RunStatus.cancelling]), 'run-ended'),
        require(isIn($.outcome, [$.TaskStatus.completed, $.TaskStatus.failed, $.TaskStatus.cancelled]), 'not-an-outcome'),
        when($.task === 0, [
          require($.task0 === $.TaskStatus.assigned, 'already-reported'),
          // A first failure while running is retried: the task stays assigned and its worker is assigned again.
          when($.outcome === $.TaskStatus.failed && $.status === $.RunStatus.running && !$.retried0, [
            set('retried0', true),
            send($.w0, 'Assign', {}),
          ], [
            set('task0', $.outcome),
            when($.outcome === $.TaskStatus.completed, [set('processed', $.processed + $.items)]),
            when($.task1 !== $.TaskStatus.assigned, [
              when($.outcome === $.TaskStatus.completed && $.task1 === $.TaskStatus.completed, [
                set('status', $.RunStatus.completed),
              ], [
                when($.outcome === $.TaskStatus.failed || $.task1 === $.TaskStatus.failed, [
                  set('status', $.RunStatus.failed),
                ], [
                  set('status', $.RunStatus.cancelled),
                ]),
              ]),
            ]),
          ]),
        ], [
          require($.task1 === $.TaskStatus.assigned, 'already-reported'),
          // A first failure while running is retried: the task stays assigned and its worker is assigned again.
          when($.outcome === $.TaskStatus.failed && $.status === $.RunStatus.running && !$.retried1, [
            set('retried1', true),
            send($.w1, 'Assign', {}),
          ], [
            set('task1', $.outcome),
            when($.outcome === $.TaskStatus.completed, [set('processed', $.processed + $.items)]),
            when($.task0 !== $.TaskStatus.assigned, [
              when($.outcome === $.TaskStatus.completed && $.task0 === $.TaskStatus.completed, [
                set('status', $.RunStatus.completed),
              ], [
                when($.outcome === $.TaskStatus.failed || $.task0 === $.TaskStatus.failed, [
                  set('status', $.RunStatus.failed),
                ], [
                  set('status', $.RunStatus.cancelled),
                ]),
              ]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome', 'items']),

      invariant('completed-means-both-completed', ($) =>
        implies($.status === $.RunStatus.completed, $.task0 === $.TaskStatus.completed && $.task1 === $.TaskStatus.completed)),
    ],
  }),

  machine('Worker', {
    service: true,
    state: {
      status: field(t.named('WorkerStatus'), ($) => $.WorkerStatus.idle),
      task: field(t.range(0, 1), () => 0),
      run: field(t.ref('Run'), ($) => $.none),
    },
    items: [
      action('Assign', {}),
      action('Abort', {}),
      action('Done', { items: t.range(1, 2) }),
      action('Fail', {}),

      on('Assign', ($) => [
        require($.status === $.WorkerStatus.idle, 'busy'),
        set('status', $.WorkerStatus.busy),
      ]),
      // An Abort that reaches an idle worker is ignored: a rejected step, which changes nothing.
      on('Abort', ($) => [
        require($.status === $.WorkerStatus.busy, 'not-busy'),
        set('status', $.WorkerStatus.idle),
        send($.run, 'Report', { task: $.task, outcome: $.TaskStatus.cancelled, items: 0 }),
      ]),
      on('Done', ($) => [
        require($.status === $.WorkerStatus.busy, 'not-busy'),
        set('status', $.WorkerStatus.idle),
        send($.run, 'Report', { task: $.task, outcome: $.TaskStatus.completed, items: $.items }),
      ], ['items']),
      on('Fail', ($) => [
        require($.status === $.WorkerStatus.busy, 'not-busy'),
        set('status', $.WorkerStatus.idle),
        send($.run, 'Report', { task: $.task, outcome: $.TaskStatus.failed, items: 0 }),
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
        implies($.run.status === $.RunStatus.completed, $.run.task0 === $.TaskStatus.completed && $.run.task1 === $.TaskStatus.completed)),
      invariant('ended-only-when-both-reported', ($) =>
        implies(isIn($.run.status, [$.RunStatus.completed, $.RunStatus.failed, $.RunStatus.cancelled]),
          $.run.task0 !== $.TaskStatus.assigned && $.run.task1 !== $.TaskStatus.assigned)),
    ],
  }),
]);
