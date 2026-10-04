// A run and its two workers: the run assigns a task to each worker, and each worker reports how its task ended.
import { module, enumType, machine, field, t, action, on, require, set, send, when, isIn, terminal, configuration, instance, invariant, implies } from '@cognitive-fab/poly/embed';

export default module('runworkers', [
  enumType('St', ['idle', 'busy', 'running', 'cancelling', 'assigned', 'completed', 'failed', 'cancelled']),
  machine('Run', {
    state: {
      status: field(t.named('St'), ($) => $.idle),
      task0: field(t.named('St'), ($) => $.idle),
      task1: field(t.named('St'), ($) => $.idle),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
      retried0: field(t.bool, () => false),
      retried1: field(t.bool, () => false),
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
      on('Report', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'run-ended'),
        require(isIn($.outcome, [$.completed, $.failed, $.cancelled]), 'bad-outcome'),
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
    ],
  }),
  machine('Worker', {
    service: true,
    state: {
      status: field(t.named('St'), ($) => $.idle),
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
  configuration('system', {
    instances: [
      instance('run', 'Run', { init: ($) => ({ w0: $.worker0, w1: $.worker1 }) }),
      instance('worker0', 'Worker', { init: ($) => ({ task: 0, run: $.run }) }),
      instance('worker1', 'Worker', { init: ($) => ({ task: 1, run: $.run }) }),
    ],
    inputs: ['run.Start', 'run.Cancel', 'worker0.Done', 'worker0.Fail', 'worker1.Done', 'worker1.Fail'],
    bounds: { transit: 4 },
    properties: [
      invariant('completed-only-when-both', ($) => implies($.run.status === $.completed, $.run.task0 === $.completed && $.run.task1 === $.completed)),
      invariant('ended-only-when-both-reported', ($) => implies(isIn($.run.status, [$.completed, $.failed, $.cancelled]), $.run.task0 !== $.assigned && $.run.task1 !== $.assigned)),
    ],
  }),
]);
