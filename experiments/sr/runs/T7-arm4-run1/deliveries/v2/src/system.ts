// T7, a run and its workers: the run and its two workers, which talk only by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, terminal, isIn, invariant,
  configuration, instance, implies,
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
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.failed, $.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
      action('Timeout', { task: t.range(0, 1) }),
      action('Report', { task: t.range(0, 1), outcome: t.named('TaskStatus') }),

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

      // A timeout records the task as failed for the last time and aborts its worker; any later report of
      // the task is ignored, since the task is no longer assigned.
      on('Timeout', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'not-running'),
        require(($.task === 0 && $.task0 === $.assigned) || ($.task === 1 && $.task1 === $.assigned), 'task-not-assigned'),
        when($.task === 0, [
          set('task0', $.failed),
          when($.task1 !== $.assigned, [set('status', $.failed)]),
          send($.w0, 'Abort', {}),
        ], [
          set('task1', $.failed),
          when($.task0 !== $.assigned, [set('status', $.failed)]),
          send($.w1, 'Abort', {}),
        ]),
      ], ['task']),

      // A report sets its task's status, then the run's status from both tasks' new statuses.
      on('Report', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'run-ended'),
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        require(($.task === 0 && $.task0 === $.assigned) || ($.task === 1 && $.task1 === $.assigned), 'task-reported'),
        // A first failure while running is retried: the task stays assigned and its worker is assigned again.
        when($.task === 0, [
          when($.outcome === $.failed && $.status === $.running && !$.retried0, [
            set('retried0', true),
            send($.w0, 'Assign', {}),
          ], [
            set('task0', $.outcome),
            when($.task1 !== $.assigned, [
              when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)], [
                when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
              ]),
            ]),
          ]),
        ], [
          when($.outcome === $.failed && $.status === $.running && !$.retried1, [
            set('retried1', true),
            send($.w1, 'Assign', {}),
          ], [
            set('task1', $.outcome),
            when($.task0 !== $.assigned, [
              when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)], [
                when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
              ]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome']),

      invariant('completed-when-both-completed', ($) =>
        implies($.status === $.completed, $.task0 === $.completed && $.task1 === $.completed)),
      invariant('ended-when-both-reported', ($) =>
        implies(isIn($.status, [$.completed, $.failed, $.cancelled]), $.task0 !== $.assigned && $.task1 !== $.assigned)),
      invariant('failed-when-one-failed', ($) =>
        implies($.status === $.failed, $.task0 === $.failed || $.task1 === $.failed)),
    ],
  }),

  // A worker is a long-lived service: it never ends, and is idle between tasks.
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
      action('Done', {}),
      action('Fail', {}),

      on('Assign', ($) => [require($.status === $.idle, 'not-idle'), set('status', $.busy)]),
      // An Abort that reaches an idle worker is ignored: a rejected step changes nothing.
      on('Abort', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.cancelled }),
      ]),
      on('Done', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.completed }),
      ]),
      on('Fail', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.failed }),
      ]),
    ],
  }),

  configuration('one-run', {
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
      // A run ends with a worker still busy only when that worker's task timed out.
      invariant('ended-with-busy-worker-only-on-timeout', ($) =>
        implies(isIn($.run.status, [$.completed, $.failed, $.cancelled]),
          implies($.worker0.status === $.busy, $.run.task0 === $.failed) &&
          implies($.worker1.status === $.busy, $.run.task1 === $.failed))),
    ],
  }),
]);
