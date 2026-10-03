// T7, a run and its workers: the run assigns both tasks, the workers report, and a cancel aborts what is still assigned.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, terminal, isIn,
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
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.failed, $.cancelled])),
      action('Start', {}),
      action('Cancel', {}),
      action('Report', { task: t.range(0, 1), outcome: t.named('TaskStatus').check([name('completed'), name('failed'), name('cancelled')]) }),

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

      // A finished run ignores further reports; a report for a task already reported is ignored too.
      on('Report', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'run-not-active'),
        // The run's status follows once the other task has reported too.
        when($.task === 0, [
          require($.task0 === $.assigned, 'task-already-reported'),
          set('task0', $.outcome),
          when($.task1 === $.completed, [set('status', $.outcome)]),
          when($.task1 === $.failed, [set('status', $.failed)]),
          when($.task1 === $.cancelled, [
            when($.outcome === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
          ]),
        ], [
          require($.task1 === $.assigned, 'task-already-reported'),
          set('task1', $.outcome),
          when($.task0 === $.completed, [set('status', $.outcome)]),
          when($.task0 === $.failed, [set('status', $.failed)]),
          when($.task0 === $.cancelled, [
            when($.outcome === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
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
      // An Abort that reaches an idle worker is ignored.
      on('Abort', ($) => [
        when($.status === $.busy, [
          set('status', $.idle),
          send($.run, 'Report', { task: $.task, outcome: $.cancelled }),
        ]),
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
      // completed only when both workers reported completion
      // (written as a configuration invariant over the run's fields)
    ],
  }),
]);
