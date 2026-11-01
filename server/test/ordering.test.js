import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computePosition, GAP } from '../src/lib/ordering.js';

const list = (...positions) => positions.map((position, i) => ({ id: `t${i}`, position }));

describe('computePosition', () => {
  test('empty list gets the first slot', () => {
    assert.equal(computePosition([]).position, GAP);
  });

  test('no anchors appends to the end', () => {
    assert.equal(computePosition(list(1024, 2048)).position, 3072);
  });

  test('between two neighbours takes the midpoint', () => {
    assert.equal(computePosition(list(1024, 2048), { afterId: 't0', beforeId: 't1' }).position, 1536);
  });

  test('at the top uses beforeId only', () => {
    assert.equal(computePosition(list(1024, 2048), { afterId: null, beforeId: 't0' }).position, 0);
  });

  test('afterId wins when both anchors exist but are no longer adjacent', () => {
    const { position } = computePosition(list(1000, 1500, 2000), { afterId: 't0', beforeId: 't2' });
    assert.equal(position, 1250);
  });

  test('falls back to beforeId, then to the end, when anchors disappeared', () => {
    assert.equal(computePosition(list(1000, 2000), { afterId: 'gone', beforeId: 't1' }).position, 1500);
    assert.equal(computePosition(list(1000, 2000), { afterId: 'gone', beforeId: 'gone2' }).position, 3024);
  });

  test('renumbers the list when neighbours are too close', () => {
    const result = computePosition(list(1, 1 + 1e-9, 5), { afterId: 't0', beforeId: 't1' });
    assert.ok(result.rebalanced);
    assert.deepEqual(result.rebalanced.map((s) => s.position), [1024, 2048, 3072]);
    assert.equal(result.position, 1536);
  });
});
