// T7: a run and its two workers, talking by messages.
import {
  module, machine, field, t, action, on, require, set, when, send, configuration, instance, implies, invariant, isIn, terminal,
} from '@cognitive-fab/poly/embed';

export default module('t7', [
  machine('Run', {
    state: {
      status: field(t.string, () => 'idle', { check: ['idle', 'running', 'cancelling', 'completed', 'failed', 'cancelled'] }),
      task0: field(t.string, () => 'idle', { check: ['idle', 'assigned', 'completed', 'failed', 'cancelled'] }),
      task1: field(t.string, () => 'idle', { check: ['idle', 'assigned', 'completed', 'failed', 'cancelled'] }),
      retried0: field(t.bool, () => false),
      retried1: field(t.bool, () => false),
      processed: field(t.range(0, 4), () => 0),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      // An ended run ignores further reports.
      terminal(($) => isIn($.status, ['completed', 'failed', 'cancelled'])),
      action('Start', {}),
      action('Cancel', {}),
      action('TaskTimeout', { task: t.range(0, 1) }),
      action('Report', { task: t.range(0, 1), outcome: t.string.check(['completed', 'failed', 'cancelled']), items: t.range(0, 2) }),
      on('Start', ($) => [
        require($.status === 'idle', 'already-started'),
        set('status', 'running'),
        set('task0', 'assigned'),
        set('task1', 'assigned'),
        send($.w0, 'Assign', {}),
        send($.w1, 'Assign', {}),
      ]),
      on('Cancel', ($) => [
        require($.status === 'running', 'not-running'),
        set('status', 'cancelling'),
        when($.task0 === 'assigned', [send($.w0, 'Abort', {})]),
        when($.task1 === 'assigned', [send($.w1, 'Abort', {})]),
      ]),
      // A timeout records the task as failed for the last time and aborts its worker.
      on('TaskTimeout', ($) => [
        require($.task === 0 || $.task === 1, 'unknown-task'),
        require($.status === 'running' || $.status === 'cancelling', 'not-active'),
        when($.task === 0, [
          require($.task0 === 'assigned', 'not-assigned'),
          set('task0', 'failed'),
          when($.task1 !== 'assigned', [set('status', 'failed')]),
          send($.w0, 'Abort', {}),
        ], [
          require($.task1 === 'assigned', 'not-assigned'),
          set('task1', 'failed'),
          when($.task0 !== 'assigned', [set('status', 'failed')]),
          send($.w1, 'Abort', {}),
        ]),
      ], ['task']),
      // A report for a task no longer assigned is ignored (already-reported).
      // A first failure while running is retried: the worker gets Assign again and the task stays assigned.
      // Any other report sets its task's status, then the run's status from both tasks' (post) statuses.
      on('Report', ($) => [
        require($.status === 'running' || $.status === 'cancelling', 'not-active'),
        when($.task === 0, [
          require($.task0 === 'assigned', 'already-reported'),
          when($.outcome === 'failed' && $.status === 'running' && !$.retried0, [
            set('retried0', true),
            send($.w0, 'Assign', {}),
          ], [
            set('task0', $.outcome),
            when($.outcome === 'completed', [set('processed', $.processed + $.items)]),
            when($.outcome === 'completed' && $.task1 === 'completed', [set('status', 'completed')], [
              when($.task1 !== 'assigned', [
                when($.outcome === 'failed' || $.task1 === 'failed', [set('status', 'failed')], [set('status', 'cancelled')]),
              ]),
            ]),
          ]),
        ], [
          require($.task1 === 'assigned', 'already-reported'),
          when($.outcome === 'failed' && $.status === 'running' && !$.retried1, [
            set('retried1', true),
            send($.w1, 'Assign', {}),
          ], [
            set('task1', $.outcome),
            when($.outcome === 'completed', [set('processed', $.processed + $.items)]),
            when($.outcome === 'completed' && $.task0 === 'completed', [set('status', 'completed')], [
              when($.task0 !== 'assigned', [
                when($.outcome === 'failed' || $.task0 === 'failed', [set('status', 'failed')], [set('status', 'cancelled')]),
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
      status: field(t.string, () => 'idle', { check: ['idle', 'busy'] }),
      task: field(t.range(0, 1), () => 0),
      run: field(t.ref('Run'), ($) => $.none),
    },
    items: [
      action('Assign', {}),
      action('Abort', {}),
      action('WorkDone', { items: t.range(1, 2) }),
      action('WorkFailed', {}),
      on('Assign', ($) => [require($.status === 'idle', 'not-idle'), set('status', 'busy')]),
      // An Abort that reaches an idle worker is ignored: refused, it changes nothing.
      on('Abort', ($) => [
        require($.status === 'busy', 'not-busy'),
        set('status', 'idle'),
        send($.run, 'Report', { task: $.task, outcome: 'cancelled', items: 0 }),
      ]),
      on('WorkDone', ($) => [
        require($.items === 1 || $.items === 2, 'bad-items'),
        require($.status === 'busy', 'not-busy'),
        set('status', 'idle'),
        send($.run, 'Report', { task: $.task, outcome: 'completed', items: $.items }),
      ], ['items']),
      on('WorkFailed', ($) => [
        require($.status === 'busy', 'not-busy'),
        set('status', 'idle'),
        send($.run, 'Report', { task: $.task, outcome: 'failed', items: 0 }),
      ]),
    ],
  }),
  configuration('system', {
    instances: [
      instance('run', 'Run', { init: ($) => ({ w0: $.worker0, w1: $.worker1 }) }),
      instance('worker0', 'Worker', { init: ($) => ({ run: $.run, task: 0 }) }),
      instance('worker1', 'Worker', { init: ($) => ({ run: $.run, task: 1 }) }),
    ],
    inputs: ['run.Start', 'run.Cancel', 'run.TaskTimeout','worker0.WorkDone', 'worker0.WorkFailed', 'worker1.WorkDone', 'worker1.WorkFailed'],
    bounds: { transit: 6 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === 'completed', $.run.task0 === 'completed' && $.run.task1 === 'completed')),
      invariant('ends-only-when-both-reported', ($) =>
        implies(isIn($.run.status, ['completed', 'failed', 'cancelled']), $.run.task0 !== 'assigned' && $.run.task1 !== 'assigned')),
    ],
  }),
]);
