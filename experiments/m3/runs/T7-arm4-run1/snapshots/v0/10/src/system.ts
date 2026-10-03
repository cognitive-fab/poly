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
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.failed, $.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
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

      // A finished run ignores further reports, and a task reports once. The run's status follows once both
      // tasks have reported: completed if both completed, failed if any failed, cancelled otherwise.
      on('Report', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'run-not-active'),
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        when($.task === 0, [
          require($.task0 === $.assigned, 'task-already-reported'),
          set('task0', $.outcome),
          when($.task1 !== $.assigned, [
            when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [
              when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)],
                [set('status', $.cancelled)]),
            ]),
          ]),
        ], [
          require($.task1 === $.assigned, 'task-already-reported'),
          set('task1', $.outcome),
          when($.task0 !== $.assigned, [
            when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [
              when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)],
                [set('status', $.cancelled)]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome']),
    ],
  }),

  machine('Worker', {
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

      on('Assign', ($) => [
        require($.status === $.idle, 'worker-busy'),
        set('status', $.busy),
      ]),
      // An Abort that reaches an idle worker is ignored: rejected, it changes nothing.
      on('Abort', ($) => [
        require($.status === $.busy, 'worker-idle'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.cancelled }),
      ]),
      on('WorkDone', ($) => [
        require($.status === $.busy, 'worker-not-busy'),
        set('status', $.idle),
        send($.run, 'Report', { task: $.task, outcome: $.completed }),
      ]),
      on('WorkFailed', ($) => [
        require($.status === $.busy, 'worker-not-busy'),
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
    inputs: ['run.Start', 'run.Cancel', 'worker0.WorkDone', 'worker0.WorkFailed', 'worker1.WorkDone', 'worker1.WorkFailed'],
    bounds: { transit: 4 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === $.completed, $.run.task0 === $.completed && $.run.task1 === $.completed)),
      invariant('ends-only-when-both-reported', ($) =>
        implies(isIn($.run.status, [$.completed, $.failed, $.cancelled]),
          !isIn($.run.task0, [$.idle, $.assigned]) && !isIn($.run.task1, [$.idle, $.assigned]))),
      invariant('reported-task-has-idle-worker', ($) =>
        implies(!isIn($.run.task0, [$.idle, $.assigned]), $.worker0.status === $.idle) &&
        implies(!isIn($.run.task1, [$.idle, $.assigned]), $.worker1.status === $.idle)),
    ],
  }),
]);
