import { describe, expect, test } from 'vitest';
import { boardReducer, groupTasks, initialBoardState } from './boardReducer.js';
import { History } from './history.js';
import { computePosition } from '../lib/ordering.js';

const task = (id, over = {}) => ({
  id, columnId: 'c1', boardId: 'b', title: id, position: 1024, version: 1, createdAt: '2026-01-01T00:00:00Z', ...over,
});
const ready = (tasks) =>
  boardReducer(initialBoardState, {
    type: 'loaded', board: { id: 'b' }, columns: [{ id: 'c1' }, { id: 'c2' }], tasks,
  });

describe('boardReducer', () => {
  test('ignores events that carry an older or equal version (our own echo)', () => {
    let s = ready([task('a', { version: 3, title: 'new' })]);
    s = boardReducer(s, { type: 'task/upsert', task: task('a', { version: 2, title: 'old' }) });
    s = boardReducer(s, { type: 'task/upsert', task: task('a', { version: 3, title: 'dup' }) });
    expect(s.tasks.a.title).toBe('new');
  });

  test('accepts newer versions', () => {
    let s = ready([task('a')]);
    s = boardReducer(s, { type: 'task/upsert', task: task('a', { version: 2, title: 'changed' }) });
    expect(s.tasks.a.title).toBe('changed');
  });

  test('a late event cannot resurrect a deleted task', () => {
    let s = ready([task('a', { version: 2 })]);
    s = boardReducer(s, { type: 'task/remove', id: 'a', version: 3 });
    s = boardReducer(s, { type: 'task/upsert', task: task('a', { version: 2 }) });
    expect(s.tasks.a).toBeUndefined();
    // but a restore (higher version) brings it back
    s = boardReducer(s, { type: 'task/upsert', task: task('a', { version: 4 }) });
    expect(s.tasks.a).toBeDefined();
  });

  test('optimistic patch keeps the version, so the server answer replaces it', () => {
    let s = ready([task('a')]);
    s = boardReducer(s, { type: 'task/patch', id: 'a', patch: { columnId: 'c2' } });
    expect(s.tasks.a.columnId).toBe('c2');
    expect(s.tasks.a.version).toBe(1);
    s = boardReducer(s, { type: 'task/upsert', task: task('a', { columnId: 'c2', version: 2 }) });
    expect(s.tasks.a.version).toBe(2);
  });

  test('rollback restores the snapshot unless a newer version arrived', () => {
    const original = task('a');
    let s = ready([original]);
    s = boardReducer(s, { type: 'task/patch', id: 'a', patch: { title: 'oops' } });
    expect(boardReducer(s, { type: 'task/rollback', task: original }).tasks.a.title).toBe('a');

    const newer = boardReducer(s, { type: 'task/upsert', task: task('a', { version: 2, title: 'from server' }) });
    expect(boardReducer(newer, { type: 'task/rollback', task: original }).tasks.a.title).toBe('from server');
  });

  test('rollback of an optimistic delete brings the task back', () => {
    const original = task('a');
    let s = ready([original]);
    s = boardReducer(s, { type: 'task/remove', id: 'a', version: 1 });
    s = boardReducer(s, { type: 'task/rollback', task: original });
    expect(s.tasks.a).toBeDefined();
  });

  test('positions.changed updates positions only', () => {
    let s = ready([task('a', { position: 1 }), task('b', { position: 2 })]);
    s = boardReducer(s, { type: 'positions/apply', positions: [{ id: 'a', position: 1024 }, { id: 'b', position: 2048 }] });
    expect([s.tasks.a.position, s.tasks.b.position, s.tasks.a.version]).toEqual([1024, 2048, 1]);
  });

  test('groupTasks sorts each column by position and ignores unknown columns', () => {
    const s = ready([
      task('a', { position: 3000 }), task('b', { position: 1000 }), task('c', { position: 2000, columnId: 'c2' }),
      task('x', { columnId: 'gone' }),
    ]);
    const g = groupTasks(s);
    expect(g.c1.map((t) => t.id)).toEqual(['b', 'a']);
    expect(g.c2.map((t) => t.id)).toEqual(['c']);
    expect(g.gone).toBeUndefined();
  });
});

describe('History', () => {
  const cmd = (label) => ({ label, undo: () => {}, redo: () => {} });

  test('a new action clears the redo stack', () => {
    const h = new History();
    h.record(cmd('one'));
    h.pushRedo(h.takeUndo());
    expect(h.canRedo).toBe(true);
    h.record(cmd('two'));
    expect(h.canRedo).toBe(false);
    expect(h.nextUndoLabel).toBe('two');
  });

  test('is capped at the limit, dropping the oldest', () => {
    const h = new History(2);
    ['a', 'b', 'c'].forEach((l) => h.record(cmd(l)));
    expect(h.undoStack.map((c) => c.label)).toEqual(['b', 'c']);
  });
});

describe('client ordering', () => {
  test('puts a dropped task between its neighbours', () => {
    const siblings = [{ id: 'a', position: 1024 }, { id: 'b', position: 2048 }];
    expect(computePosition(siblings, { afterId: 'a', beforeId: 'b' }).position).toBe(1536);
  });
});
