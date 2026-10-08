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
      // A report is recorded only while the run is running or cancelling and its task has not reported;
      // otherwise it is ignored (an observable rejection). Once both tasks have reported, the run ends.
      on('Report', ($) => [
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'not-an-outcome'),
        require(isIn($.status, [$.running, $.cancelling]), 'run-ended'),
        when($.task === 0, [
          require($.task0 === $.assigned, 'already-reported'),
          set('task0', $.outcome),
          when($.task1 !== $.assigned, [
            when($.outcome === $.failed || $.task1 === $.failed, [set('status', $.failed)], [
              when($.outcome === $.completed && $.task1 === $.completed, [set('status', $.completed)], [set('status', $.cancelled)]),
            ]),
          ]),
        ], [
          require($.task1 === $.assigned, 'already-reported'),
          set('task1', $.outcome),
          when($.task0 !== $.assigned, [
            when($.outcome === $.failed || $.task0 === $.failed, [set('status', $.failed)], [
              when($.outcome === $.completed && $.task0 === $.completed, [set('status', $.completed)], [set('status', $.cancelled)]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome']),
      invariant('completed-when-both-completed', ($) => implies($.status === $.completed, $.task0 === $.completed && $.task1 === $.completed)),
      invariant('ended-when-both-reported', ($) => implies(isIn($.status, [$.completed, $.failed, $.cancelled]),
        isIn($.task0, [$.completed, $.failed, $.cancelled]) && isIn($.task1, [$.completed, $.failed, $.cancelled]))),
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
      action('Done', {}),
      action('Fail', {}),
      on('Assign', ($) => [require($.status === $.idle, 'busy'), set('status', $.busy)]),
      // An Abort that reaches an idle worker is ignored (an observable rejection).
      on('Abort', ($) => [
        require($.status === $.busy, 'idle-ignores-abort'),
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
  configuration('system', {
    instances: [
      instance('run', 'Run', { init: ($) => ({ w0: $.worker0, w1: $.worker1 }) }),
      instance('worker0', 'Worker', { init: ($) => ({ task: 0, run: $.run }) }),
      instance('worker1', 'Worker', { init: ($) => ({ task: 1, run: $.run }) }),
    ],
    inputs: ['run.Start', 'run.Cancel', 'worker0.Done', 'worker0.Fail', 'worker1.Done', 'worker1.Fail'],
    bounds: { transit: 4 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === $.completed, $.run.task0 === $.completed && $.run.task1 === $.completed)),
    ],
  }),
]);
