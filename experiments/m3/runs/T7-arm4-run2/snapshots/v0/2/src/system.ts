// A run and its two workers (T7): the run assigns a task to each worker, the workers report each outcome,
// and the run's status follows the reports, whatever order the messages arrive in.
import {
  module, enumType, machine, field, t, action, on, require, set, let_, when, send, isIn, implies,
  configuration, instance, invariant,
} from '@cognitive-fab/poly/embed';

export default module('workflow', [
  // One set of status names, shared by the run, its tasks and the workers.
  enumType('Status', ['idle', 'assigned', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'busy']),
  machine('Run', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      task0: field(t.named('Status'), ($) => $.idle),
      task1: field(t.named('Status'), ($) => $.idle),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      action('Start', {}),
      action('Cancel', {}),
      action('Report', { task: t.range(0, 1), outcome: t.named('Status') }),
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
      on('Report', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'run-ended'),
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        // The status after the report, from this task's outcome and the other task's status.
        when($.task === 0, [
          require($.task0 === $.assigned, 'already-reported'),
          set('task0', $.outcome),
          when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)], [
            when($.task1 !== $.assigned, [
              when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
            ]),
          ]),
        ], [
          require($.task1 === $.assigned, 'already-reported'),
          set('task1', $.outcome),
          when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)], [
            when($.task0 !== $.assigned, [
              when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome']),
    ],
  }),
  machine('Worker', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      task: field(t.range(0, 1), () => 0),
      run: field(t.ref('Run'), ($) => $.none),
    },
    items: [
      action('Assign', {}),
      action('Abort', {}),
      action('Done', {}),
      action('Fail', {}),
      on('Assign', ($) => [require($.status === $.idle, 'not-idle'), set('status', $.busy)]),
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
]);
