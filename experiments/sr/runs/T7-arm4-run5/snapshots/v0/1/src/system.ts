// T7, a run and its workers: the run assigns its two tasks, each to its own worker, and records their reports.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, terminal, invariant, isIn, implies,
  configuration, instance,
} from '@cognitive-fab/poly/embed';

export default module('runs', [
  // One vocabulary for every status: the run's, its tasks', a report's outcome and a worker's.
  enumType('St', ['idle', 'busy', 'running', 'cancelling', 'assigned', 'completed', 'failed', 'cancelled']),

  machine('Run', {
    state: {
      status: field(t.named('St'), ($) => $.idle),
      task0: field(t.named('St'), ($) => $.idle),
      task1: field(t.named('St'), ($) => $.idle),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.failed, $.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
      action('Report', { task: t.range(0, 1), outcome: t.named('St') }),

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

      // A report sets its task's status; the run ends once both tasks have reported.
      on('Report', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'run-ended'),
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        require(($.task === 0 && $.task0 === $.assigned) || ($.task === 1 && $.task1 === $.assigned), 'already-reported'),
        when($.task === 0, [
          set('task0', $.outcome),
          when($.task1 !== $.assigned, [
            when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)], [
              when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
            ]),
          ]),
        ], [
          set('task1', $.outcome),
          when($.task0 !== $.assigned, [
            when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)], [
              when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome']),

      invariant('completed-when-both-completed', ($) =>
        implies($.status === $.completed, $.task0 === $.completed && $.task1 === $.completed)),
      invariant('ended-when-both-reported', ($) =>
        implies(isIn($.status, [$.completed, $.failed, $.cancelled]), $.task0 !== $.assigned && $.task1 !== $.assigned)),
      invariant('failed-when-a-task-failed', ($) =>
        implies($.status === $.failed, $.task0 === $.failed || $.task1 === $.failed)),
    ],
  }),

  machine('Worker', {
    state: {
      status: field(t.named('St'), ($) => $.idle),
      task: field(t.range(0, 1), () => 0),
      run: field(t.ref('Run'), ($) => $.none),
    },
    items: [
      action('Assign', {}),
      action('Abort', {}),
      action('WorkDone', {}),
      action('WorkFailed', {}),

      on('Assign', ($) => [require($.status === $.idle, 'busy'), set('status', $.busy)]),
      // An Abort that reaches an idle worker is ignored: a rejected step changes nothing.
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
    inputs: ['run.Start', 'run.Cancel', 'worker0.WorkDone', 'worker0.WorkFailed', 'worker1.WorkDone', 'worker1.WorkFailed'],
    bounds: { transit: 4 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === $.completed, $.run.task0 === $.completed && $.run.task1 === $.completed)),
      invariant('ended-only-when-workers-idle', ($) =>
        implies(isIn($.run.status, [$.completed, $.failed, $.cancelled]), $.worker0.status === $.idle && $.worker1.status === $.idle)),
    ],
  }),
]);
