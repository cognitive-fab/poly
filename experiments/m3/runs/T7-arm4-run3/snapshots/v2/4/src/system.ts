// T7, a run and its workers: the run assigns its two tasks to two workers, which report back by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, terminal, invariant,
  configuration, instance, isIn, implies,
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
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.failed, $.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
      action('TaskTimeout', { task: t.int.check([0, 1], 'strict') }),
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

      // A timeout records the task as failed for good, as a last failure would, and aborts its worker.
      on('TaskTimeout', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'not-running'),
        when($.task === 0, [
          require($.task0 === $.assigned, 'not-assigned'),
          set('task0', $.failed),
          when($.task1 !== $.assigned, [set('status', $.failed)]),
          send($.w0, 'Abort', {}),
        ], [
          require($.task1 === $.assigned, 'not-assigned'),
          set('task1', $.failed),
          when($.task0 !== $.assigned, [set('status', $.failed)]),
          send($.w1, 'Abort', {}),
        ]),
      ], ['task']),

      // The status after a report, from this task's outcome and the other task's status.
      on('Report', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'run-ended'),
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        // A first failure while running is retried: the task stays assigned and its worker is assigned again.
        when($.task === 0, [
          require($.task0 === $.assigned, 'already-reported'),
          when($.outcome === $.failed && $.status === $.running && !$.retried0, [
            set('retried0', true),
            send($.w0, 'Assign', {}),
          ], [
            set('task0', $.outcome),
            when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)], [
              when($.task1 !== $.assigned, [
                when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
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
            when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)], [
              when($.task0 !== $.assigned, [
                when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
              ]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome']),

      invariant('completed-when-both-completed', ($) =>
        implies($.status === $.completed, $.task0 === $.completed && $.task1 === $.completed)),
      invariant('ended-when-both-reported', ($) =>
        implies(isIn($.status, [$.completed, $.failed, $.cancelled]),
          $.task0 !== $.assigned && $.task0 !== $.idle && $.task1 !== $.assigned && $.task1 !== $.idle)),
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
      action('WorkDone', {}),
      action('WorkFailed', {}),

      on('Assign', ($) => [require($.status === $.idle, 'busy'), set('status', $.busy)]),
      on('Abort', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.cancelled }),
      ]),
      on('WorkDone', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.completed }),
      ]),
      on('WorkFailed', ($) => [
        require($.status === $.busy, 'not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.failed }),
      ]),
    ],
  }),

  configuration('system', {
    instances: [
      instance('run', 'Run', { init: ($) => ({ w0: $.worker0, w1: $.worker1 }) }),
      instance('worker0', 'Worker', { init: ($) => ({ task: 0, run: $.run }) }),
      instance('worker1', 'Worker', { init: ($) => ({ task: 1, run: $.run }) }),
    ],
    inputs: ['run.Start', 'run.Cancel', 'run.TaskTimeout','worker0.WorkDone', 'worker0.WorkFailed', 'worker1.WorkDone', 'worker1.WorkFailed'],
    bounds: { transit: 4 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === $.completed, $.run.task0 === $.completed && $.run.task1 === $.completed)),
    ],
  }),
]);
