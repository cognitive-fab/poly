// Workflow run status: one Run instance per run id, three tasks, and the run's status derived from them.
// A task command writes one task and the status in the same step; the status is computed from the post-state,
// written as "post task i is X" = (task === i && v === X) || (task !== i && task_i === X), with v the new value.
import { module, enumType, machine, field, t, action, on, require, set, when, terminal, invariant, implies, isIn } from '@cognitive-fab/poly/embed';

export default module('workflow', [
  // idle is the state of a run before start; a query never sees it, since only start creates a run.
  enumType('Status', ['idle', 'queued', 'running', 'evicted', 'completed', 'failed', 'cancelled']),
  machine('Run', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      task0: field(t.named('Status'), ($) => $.idle),
      task1: field(t.named('Status'), ($) => $.idle),
      task2: field(t.named('Status'), ($) => $.idle),
    },
    items: [
      terminal(($) => isIn($.status, [$.completed, $.cancelled])),
      action('Start', {}),
      action('TaskStarted', { task: t.int.check(0, 2, 'strict') }),
      action('TaskCompleted', { task: t.int.check(0, 2, 'strict') }),
      action('TaskFailed', { task: t.int.check(0, 2, 'strict') }),
      action('TaskEvicted', { task: t.int.check(0, 2, 'strict') }),
      action('TaskRequeued', { task: t.int.check(0, 2, 'strict') }),
      action('TaskRetried', { task: t.int.check(0, 2, 'strict') }),
      action('Cancel', {}),
      action('CancelTask', { task: t.int.check(0, 2, 'strict') }),

      on('Start', ($) => [
        require($.status === $.idle, 'run-exists'),
        set('status', $.queued),
        set('task0', $.queued),
        set('task1', $.queued),
        set('task2', $.queued),
      ]),

      // queued -> running. All running: running; else a failed task: failed; else running.
      on('TaskStarted', ($) => [
        require(($.task === 0 && $.task0 === $.queued) || ($.task === 1 && $.task1 === $.queued) || ($.task === 2 && $.task2 === $.queued), 'task-not-queued'),
        when($.task === 0, [set('task0', $.running)]),
        when($.task === 1, [set('task1', $.running)]),
        when($.task === 2, [set('task2', $.running)]),
        when(($.task !== 0 && $.task0 === $.failed) || ($.task !== 1 && $.task1 === $.failed) || ($.task !== 2 && $.task2 === $.failed),
          [set('status', $.failed)],
          [set('status', $.running)]),
      ], ['task']),

      // running -> completed.
      on('TaskCompleted', ($) => [
        require(($.task === 0 && $.task0 === $.running) || ($.task === 1 && $.task1 === $.running) || ($.task === 2 && $.task2 === $.running), 'task-not-running'),
        when($.task === 0, [set('task0', $.completed)]),
        when($.task === 1, [set('task1', $.completed)]),
        when($.task === 2, [set('task2', $.completed)]),
        when(($.task === 0 || $.task0 === $.completed) && ($.task === 1 || $.task1 === $.completed) && ($.task === 2 || $.task2 === $.completed),
          [set('status', $.completed)],
          [when(($.task !== 0 && $.task0 === $.failed) || ($.task !== 1 && $.task1 === $.failed) || ($.task !== 2 && $.task2 === $.failed),
            [set('status', $.failed)],
            [when(($.task !== 0 && isIn($.task0, [$.queued, $.running, $.evicted])) || ($.task !== 1 && isIn($.task1, [$.queued, $.running, $.evicted])) || ($.task !== 2 && isIn($.task2, [$.queued, $.running, $.evicted])),
              [set('status', $.running)],
              [set('status', $.cancelled)])])]),
      ], ['task']),

      // running -> failed: the run is failed.
      on('TaskFailed', ($) => [
        require(($.task === 0 && $.task0 === $.running) || ($.task === 1 && $.task1 === $.running) || ($.task === 2 && $.task2 === $.running), 'task-not-running'),
        when($.task === 0, [set('task0', $.failed)]),
        when($.task === 1, [set('task1', $.failed)]),
        when($.task === 2, [set('task2', $.failed)]),
        set('status', $.failed),
      ], ['task']),

      // running -> evicted. All evicted: evicted; else a failed task: failed; else running.
      on('TaskEvicted', ($) => [
        require(($.task === 0 && $.task0 === $.running) || ($.task === 1 && $.task1 === $.running) || ($.task === 2 && $.task2 === $.running), 'task-not-running'),
        when($.task === 0, [set('task0', $.evicted)]),
        when($.task === 1, [set('task1', $.evicted)]),
        when($.task === 2, [set('task2', $.evicted)]),
        when(($.task === 0 || $.task0 === $.evicted) && ($.task === 1 || $.task1 === $.evicted) && ($.task === 2 || $.task2 === $.evicted),
          [set('status', $.evicted)],
          [when(($.task !== 0 && $.task0 === $.failed) || ($.task !== 1 && $.task1 === $.failed) || ($.task !== 2 && $.task2 === $.failed),
            [set('status', $.failed)],
            [set('status', $.running)])]),
      ], ['task']),

      // evicted -> queued. All queued: queued; else a failed task: failed; else running.
      on('TaskRequeued', ($) => [
        require(($.task === 0 && $.task0 === $.evicted) || ($.task === 1 && $.task1 === $.evicted) || ($.task === 2 && $.task2 === $.evicted), 'task-not-evicted'),
        when($.task === 0, [set('task0', $.queued)]),
        when($.task === 1, [set('task1', $.queued)]),
        when($.task === 2, [set('task2', $.queued)]),
        when(($.task === 0 || $.task0 === $.queued) && ($.task === 1 || $.task1 === $.queued) && ($.task === 2 || $.task2 === $.queued),
          [set('status', $.queued)],
          [when(($.task !== 0 && $.task0 === $.failed) || ($.task !== 1 && $.task1 === $.failed) || ($.task !== 2 && $.task2 === $.failed),
            [set('status', $.failed)],
            [set('status', $.running)])]),
      ], ['task']),

      // failed -> queued. All queued: queued; else another failed task: failed; else running.
      on('TaskRetried', ($) => [
        require(($.task === 0 && $.task0 === $.failed) || ($.task === 1 && $.task1 === $.failed) || ($.task === 2 && $.task2 === $.failed), 'task-not-failed'),
        when($.task === 0, [set('task0', $.queued)]),
        when($.task === 1, [set('task1', $.queued)]),
        when($.task === 2, [set('task2', $.queued)]),
        when(($.task === 0 || $.task0 === $.queued) && ($.task === 1 || $.task1 === $.queued) && ($.task === 2 || $.task2 === $.queued),
          [set('status', $.queued)],
          [when(($.task !== 0 && $.task0 === $.failed) || ($.task !== 1 && $.task1 === $.failed) || ($.task !== 2 && $.task2 === $.failed),
            [set('status', $.failed)],
            [set('status', $.running)])]),
      ], ['task']),

      // in flight -> cancelled. All cancelled: cancelled; else a failed task: failed; else another in flight: running;
      // else cancelled.
      on('CancelTask', ($) => [
        require(($.task === 0 && isIn($.task0, [$.queued, $.running, $.evicted])) || ($.task === 1 && isIn($.task1, [$.queued, $.running, $.evicted])) || ($.task === 2 && isIn($.task2, [$.queued, $.running, $.evicted])), 'task-not-in-flight'),
        when($.task === 0, [set('task0', $.cancelled)]),
        when($.task === 1, [set('task1', $.cancelled)]),
        when($.task === 2, [set('task2', $.cancelled)]),
        when(($.task === 0 || $.task0 === $.cancelled) && ($.task === 1 || $.task1 === $.cancelled) && ($.task === 2 || $.task2 === $.cancelled),
          [set('status', $.cancelled)],
          [when(($.task !== 0 && $.task0 === $.failed) || ($.task !== 1 && $.task1 === $.failed) || ($.task !== 2 && $.task2 === $.failed),
            [set('status', $.failed)],
            [when(($.task !== 0 && isIn($.task0, [$.queued, $.running, $.evicted])) || ($.task !== 1 && isIn($.task1, [$.queued, $.running, $.evicted])) || ($.task !== 2 && isIn($.task2, [$.queued, $.running, $.evicted])),
              [set('status', $.running)],
              [set('status', $.cancelled)])])]),
      ], ['task']),

      // Every task in flight becomes cancelled; then no task is in flight, so failed if one failed, else cancelled.
      on('Cancel', ($) => [
        require($.status !== $.idle, 'not-started'),
        require(isIn($.task0, [$.queued, $.running, $.evicted]) || isIn($.task1, [$.queued, $.running, $.evicted]) || isIn($.task2, [$.queued, $.running, $.evicted]), 'nothing-in-flight'),
        when(isIn($.task0, [$.queued, $.running, $.evicted]), [set('task0', $.cancelled)]),
        when(isIn($.task1, [$.queued, $.running, $.evicted]), [set('task1', $.cancelled)]),
        when(isIn($.task2, [$.queued, $.running, $.evicted]), [set('task2', $.cancelled)]),
        when($.task0 === $.failed || $.task1 === $.failed || $.task2 === $.failed,
          [set('status', $.failed)],
          [set('status', $.cancelled)]),
      ]),

      // The conclusion of the brief: the status never hides a task.
      invariant('completed-only-when-all-completed', ($) =>
        implies($.status === $.completed, $.task0 === $.completed && $.task1 === $.completed && $.task2 === $.completed)),
      invariant('failed-whenever-a-task-failed', ($) =>
        implies($.task0 === $.failed || $.task1 === $.failed || $.task2 === $.failed, $.status === $.failed)),
      invariant('not-final-while-in-flight', ($) =>
        implies(isIn($.task0, [$.queued, $.running, $.evicted]) || isIn($.task1, [$.queued, $.running, $.evicted]) || isIn($.task2, [$.queued, $.running, $.evicted]),
          !isIn($.status, [$.completed, $.cancelled]))),
    ],
  }),
]);
