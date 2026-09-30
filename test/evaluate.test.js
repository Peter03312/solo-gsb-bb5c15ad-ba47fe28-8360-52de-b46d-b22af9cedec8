import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimInterval,
  ordinal,
  fromOrdinal,
  daysInMonth,
  normalizeClaimDate,
  formatClaim,
} from '../src/dates.js';
import { evaluateDraft } from '../src/evaluate.js';

test('序数日往返与闰年', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2023, 2), 28);
  assert.deepEqual(fromOrdinal(ordinal(1937, 7, 7)), { year: 1937, month: 7, day: 7 });
  assert.deepEqual(fromOrdinal(ordinal(9999, 12, 31)), { year: 9999, month: 12, day: 31 });
});

test('年/月/日区间边界', () => {
  assert.deepEqual(claimInterval({ year: 1937, precision: 'year' }), {
    lo: ordinal(1937, 1, 1),
    hi: ordinal(1937, 12, 31),
  });
  assert.deepEqual(claimInterval({ year: 2024, month: 2, precision: 'month' }), {
    lo: ordinal(2024, 2, 1),
    hi: ordinal(2024, 2, 29),
  });
  const day = ordinal(1937, 7, 7);
  assert.deepEqual(claimInterval({ year: 1937, month: 7, day: 7, precision: 'day' }), {
    lo: day,
    hi: day,
  });
});

test('日期输入归一化与校验', () => {
  assert.equal(normalizeClaimDate({ year: 2000 }).precision, 'year');
  assert.deepEqual(normalizeClaimDate({ year: 2000, month: 3 }),
    { precision: 'month', year: 2000, month: 3, day: null });
  assert.equal(normalizeClaimDate({ year: 2000, month: 2, day: 29 }).precision, 'day');
  assert.match(normalizeClaimDate({ year: 2000, day: 1 }).error, /月份/);
  assert.match(normalizeClaimDate({ year: 2023, month: 2, day: 29 }).error, /没有29日/);
  assert.match(normalizeClaimDate({ year: 0 }).error, /年份/);
  assert.match(normalizeClaimDate({ year: 2020, month: 13 }).error, /月份/);
  assert.equal(formatClaim({ year: 1937, precision: 'year' }), '1937年');
});

function ev(id, title = `事件${id}`) { return { id, title }; }
function cl(id, event_id, date, extra = {}) {
  return {
    id, event_id, source: `出处${id}`, note: '',
    year: date.year, month: date.month ?? null, day: date.day ?? null,
    precision: date.month ? (date.day ? 'day' : 'month') : 'year',
    ...extra,
  };
}
function rel(id, p, s) { return { id, predecessor_id: p, successor_id: s, note: '' }; }

test('两条同年主张：先后顺序可解', () => {
  const r = evaluateDraft({
    events: [ev(1, 'A'), ev(2, 'B')],
    claims: [cl(1, 1, { year: 1937 }), cl(2, 2, { year: 1937 })],
    relations: [rel(10, 1, 2)],
    selections: new Map([[1, 1], [2, 2]]),
  });
  assert.equal(r.feasible, true);
  assert.equal(r.earliest.get(1), ordinal(1937, 1, 1));
  assert.equal(r.earliest.get(2), ordinal(1937, 1, 2));
});

test('先后倒置（年）：无解并给出涉事链与关系', () => {
  const r = evaluateDraft({
    events: [ev(1, 'A'), ev(2, 'B')],
    claims: [cl(1, 1, { year: 1938 }), cl(2, 2, { year: 1937 })],
    relations: [rel(10, 1, 2)],
    selections: new Map([[1, 1], [2, 2]]),
  });
  assert.equal(r.feasible, false);
  assert.equal(r.unsatisfiable.length, 1);
  assert.equal(r.unsatisfiable[0].event_id, 2);
  assert.deepEqual(r.unsatisfiable[0].chain, [{ event_id: 1, relation_id: 10 }]);
});

test('月粒度可行/不可行', () => {
  const ok = evaluateDraft({
    events: [ev(1), ev(2)],
    claims: [cl(1, 1, { year: 1937, month: 6 }), cl(2, 2, { year: 1937, month: 6 })],
    relations: [rel(10, 1, 2)],
    selections: new Map([[1, 1], [2, 2]]),
  });
  assert.equal(ok.feasible, true);

  const bad = evaluateDraft({
    events: [ev(1), ev(2)],
    claims: [
      cl(1, 1, { year: 1937, month: 6, day: 30 }),
      cl(2, 2, { year: 1937, month: 6, day: 30 }),
    ],
    relations: [rel(10, 1, 2)],
    selections: new Map([[1, 1], [2, 2]]),
  });
  assert.equal(bad.feasible, false);
  assert.equal(bad.unsatisfiable[0].event_id, 2);
});

test('缺失主张选择', () => {
  const r = evaluateDraft({
    events: [ev(1), ev(2)],
    claims: [cl(1, 1, { year: 1937 })],
    relations: [],
    selections: new Map([[1, 1]]),
  });
  assert.equal(r.feasible, false);
  assert.deepEqual(r.missingSelections.map((m) => m.event_id), [2]);
});

test('选择了不属于该事件的主张', () => {
  const r = evaluateDraft({
    events: [ev(1), ev(2)],
    claims: [cl(1, 1, { year: 1937 }), cl(2, 2, { year: 1938 })],
    relations: [],
    selections: new Map([[1, 2], [2, 2]]),
  });
  assert.equal(r.feasible, false);
  assert.equal(r.invalidSelections[0].event_id, 1);
});

test('关系成环检测', () => {
  const r = evaluateDraft({
    events: [ev(1), ev(2), ev(3)],
    claims: [
      cl(1, 1, { year: 1937 }),
      cl(2, 2, { year: 1937 }),
      cl(3, 3, { year: 1937 }),
    ],
    relations: [rel(10, 1, 2), rel(11, 2, 3), rel(12, 3, 1)],
    selections: new Map([[1, 1], [2, 2], [3, 3]]),
  });
  assert.equal(r.feasible, false);
  assert.equal(r.cycles.length, 1);
  assert.deepEqual([...new Set(r.cycles[0].relations)].sort(), [10, 11, 12]);
});

test('互相矛盾的主张可以共存，选择更宽的一条即可发布', () => {
  const r = evaluateDraft({
    events: [ev(1), ev(2)],
    claims: [
      cl(1, 1, { year: 1950 }),                 // 矛盾主张一
      cl(3, 1, { year: 1937 }),                 // 矛盾主张二
      cl(2, 2, { year: 1938 }),
    ],
    relations: [rel(10, 1, 2)],
    selections: new Map([[1, 3], [2, 2]]),
  });
  assert.equal(r.feasible, true);
});

test('未选主张的事件不产生误报的时间无解', () => {
  const r = evaluateDraft({
    events: [ev(1), ev(2)],
    claims: [cl(1, 1, { year: 1937 })],
    relations: [rel(10, 1, 2)],
    selections: new Map([[1, 1]]),
  });
  assert.equal(r.feasible, false);
  assert.deepEqual(r.missingSelections.map((m) => m.event_id), [2]);
  assert.deepEqual(r.unsatisfiable, []);
});

test('长链约束传播（跨年）', () => {
  const r = evaluateDraft({
    events: [ev(1), ev(2), ev(3)],
    claims: [
      cl(1, 1, { year: 1937 }),
      cl(2, 2, { year: 1938 }),
      cl(3, 3, { year: 1938 }),
    ],
    relations: [rel(10, 1, 2), rel(11, 2, 3)],
    selections: new Map([[1, 1], [2, 2], [3, 3]]),
  });
  assert.equal(r.feasible, true);
  assert.equal(r.earliest.get(3), ordinal(1938, 1, 2));
});
