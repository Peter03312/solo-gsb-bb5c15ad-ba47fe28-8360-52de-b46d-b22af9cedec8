import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { publishVersion, getPublishedTimeline, latestVersion, preview } from '../src/publish.js';
import { formatOrdinal } from '../src/dates.js';

let db;

before(async () => {
  db = await openDatabase(':memory:');
});
after(() => db.close());

function addEvent(title) {
  return db.run('INSERT INTO draft_events (title) VALUES (?)', [title]).lastInsertRowid;
}
function addClaim(eventId, date, source) {
  return db.run(
    'INSERT INTO draft_claims (event_id, year, month, day, precision, source) VALUES (?,?,?,?,?,?)',
    [eventId, date.year, date.month ?? null, date.day ?? null,
      date.day ? 'day' : date.month ? 'month' : 'year', source]
  ).lastInsertRowid;
}
function addRelation(p, s) {
  return db.run(
    'INSERT INTO draft_relations (predecessor_id, successor_id) VALUES (?,?)', [p, s]
  ).lastInsertRowid;
}

test('未发布时访客年表为 null（未发布内容不可见）', () => {
  addEvent('草稿事件');
  assert.equal(getPublishedTimeline(db), null);
});

test('无事件不可发布', async () => {
  await assert.rejects(
    () => publishVersion(db, { baseVersionId: null, selections: new Map() }),
    (err) => err.statusCode === 422
  );
  assert.equal(latestVersion(db), null);
});

test('首次发布成功并生成快照', async () => {
  // 重置草稿
  db.run('DELETE FROM draft_relations');
  db.run('DELETE FROM draft_claims');
  db.run('DELETE FROM draft_events');

  const a = addEvent('迁村');
  const b = addEvent('建祠');
  const ca = addClaim(a, { year: 1937 }, '访谈A-01');
  addClaim(a, { year: 1950 }, '档案B-07（矛盾主张，保留）');
  const cb = addClaim(b, { year: 1938 }, '访谈A-02');
  addRelation(a, b);

  const r = await publishVersion(db, {
    baseVersionId: null,
    selections: new Map([[a, ca], [b, cb]]),
    note: '首版',
  });
  assert.equal(r.versionId, 1);

  const timeline = getPublishedTimeline(db);
  assert.equal(timeline.events.length, 2);
  assert.equal(timeline.events[0].event_id, a);
  assert.equal(timeline.events[0].source, '访谈A-01');
  assert.equal(timeline.events[0].resolved_ordinal, timeline.events[0].ordinal_lo);
  assert.ok(timeline.events[1].resolved_ordinal > timeline.events[0].resolved_ordinal);
});

test('草稿后续修改不影响已发布快照', async () => {
  const before = getPublishedTimeline(db);
  db.run("UPDATE draft_events SET title = '改了标题'");
  db.run('DELETE FROM draft_claims');
  const after = getPublishedTimeline(db);
  assert.deepEqual(
    after.events.map((e) => e.title),
    before.events.map((e) => e.title)
  );
  assert.equal(after.events[0].source, '访谈A-01');
});

test('校验失败时保留上一版本', async () => {
  // 当前草稿主张已被删光 -> 无法发布
  await assert.rejects(
    () => publishVersion(db, { baseVersionId: 1, selections: new Map() }),
    (err) => err.statusCode === 422
  );
  assert.equal(latestVersion(db).id, 1);
});

test('旧 baseVersionId 触发 409，不写入数据；重新确认后成功', async () => {
  // 恢复一份可发布草稿
  db.run('DELETE FROM draft_relations');
  db.run('DELETE FROM draft_events');
  const x = addEvent('新事件X');
  const cx = addClaim(x, { year: 1940 }, '访谈C-03');

  // 别人先基于版本 1 发布版本 2
  const v2 = await publishVersion(db, {
    baseVersionId: 1,
    selections: new Map([[x, cx]]),
  });
  assert.equal(v2.versionId, 2);

  // 后者仍以版本 1 为基础提交 -> 冲突
  const x2 = addEvent('新事件Y');
  const cy = addClaim(x2, { year: 1941 }, '访谈C-04');
  await assert.rejects(
    () => publishVersion(db, {
      baseVersionId: 1,
      selections: new Map([[x, cx], [x2, cy]]),
    }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.currentVersion.id, 2);
      assert.equal(err.currentTimeline.version.id, 2);
      return true;
    }
  );
  // 冲突提交没有产生新版本
  assert.equal(latestVersion(db).id, 2);

  // 重新确认，以最新版本 2 为基础再发布
  const v3 = await publishVersion(db, {
    baseVersionId: 2,
    selections: new Map([[x, cx], [x2, cy]]),
  });
  assert.equal(v3.versionId, 3);
  assert.equal(getPublishedTimeline(db).events.length, 2);
});

test('首次发布时若已存在版本，传 null 也判冲突', async () => {
  await assert.rejects(
    () => publishVersion(db, {
      baseVersionId: null,
      selections: new Map([[1, 1]]),
    }),
    (err) => err.statusCode === 409
  );
});

test('发布快照不可修改或删除', () => {
  assert.throws(
    () => db.run('UPDATE version_events SET title = ? WHERE version_id = 1', ['x']),
    /不可修改/
  );
  assert.throws(
    () => db.run('DELETE FROM versions WHERE id = 1'),
    /不可删除/
  );
  assert.throws(
    () => db.run('UPDATE versions SET note = ? WHERE id = 1', ['x']),
    /不可修改/
  );
});

test('预览不写库', () => {
  const before = latestVersion(db).id;
  const r = preview(db, new Map());
  assert.equal(r.feasible, false);
  assert.equal(latestVersion(db).id, before);
});
