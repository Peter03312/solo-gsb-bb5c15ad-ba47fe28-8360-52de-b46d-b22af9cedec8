import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/server.js';

let db;
let server;
let base;

before(async () => {
  db = await openDatabase(':memory:');
  server = createApp(db);
  await once(server.listen(0, '127.0.0.1'), 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function req(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Editor-Token'] = token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('访客初始只能看到 null 年表', async () => {
  const t = await req('GET', '/api/timeline');
  assert.equal(t.status, 200);
  assert.equal(t.data, null);
});

test('完整流程：建事件/矛盾主张/关系 → 校验通过 → 发布 → 访客可见所选出处', async () => {
  const e1 = await req('POST', '/api/draft/events', { title: '迁村', description: '自山下迁往坡上' });
  const e2 = await req('POST', '/api/draft/events', { title: '修族谱' });
  const id1 = e1.data.id;
  const id2 = e2.data.id;

  const c1a = await req('POST', '/api/draft/claims', {
    event_id: id1, year: 1937, source: '访谈03-王氏族老', note: '口述',
  });
  const c1b = await req('POST', '/api/draft/claims', {
    event_id: id1, year: 1941, source: '县志编纂稿p88', note: '与访谈矛盾，保留',
  });
  const c2 = await req('POST', '/api/draft/claims', {
    event_id: id2, year: 1938, month: 3, source: '访谈07-李氏',
  });
  assert.equal(c1a.status, 201);

  const rel = await req('POST', '/api/draft/relations', {
    predecessor_id: id1, successor_id: id2, note: '受访者确认',
  });
  assert.equal(rel.status, 201);

  // 选择 1937 年的主张 -> 可行
  const v1 = await req('POST', '/api/draft/validate', {
    selections: { [id1]: c1a.data.id, [id2]: c2.data.id },
  });
  assert.equal(v1.data.feasible, true);

  // 改用 1941 年主张 -> 与“先于 1938-03”矛盾
  const v2 = await req('POST', '/api/draft/validate', {
    selections: { [id1]: c1b.data.id, [id2]: c2.data.id },
  });
  assert.equal(v2.data.feasible, false);
  assert.equal(v2.data.unsatisfiable[0].event_id, id2);

  // 尝试发布无解选择 -> 422，且无版本产生
  const bad = await req('POST', '/api/draft/publish', {
    baseVersionId: null,
    selections: { [id1]: c1b.data.id, [id2]: c2.data.id },
  });
  assert.equal(bad.status, 422);

  const before = await req('GET', '/api/timeline');
  assert.equal(before.data, null);

  // 正确选择后发布
  const pub = await req('POST', '/api/draft/publish', {
    baseVersionId: null,
    selections: { [id1]: c1a.data.id, [id2]: c2.data.id },
    note: 'v1',
  });
  assert.equal(pub.status, 201);
  assert.equal(pub.data.versionId, 1);

  const tl = await req('GET', '/api/timeline');
  assert.equal(tl.data.version.id, 1);
  assert.equal(tl.data.events.length, 2);
  assert.equal(tl.data.events[0].event_id, id1);
  assert.equal(tl.data.events[0].claim.source, '访谈03-王氏族老');
  // 未被选择的矛盾主张对访客不可见
  const sources = tl.data.events.flatMap((e) => [e.claim.source]);
  assert.ok(!sources.includes('县志编纂稿p88'));
  // 顺序：迁村(1937-01-01) 先于 修族谱（其区间起点 1938-03-01 已晚于前驱约束）
  assert.equal(tl.data.events[0].resolved_date, '1937-01-01');
  assert.equal(tl.data.events[1].resolved_date, '1938-03-01');
});

test('成环返回 422 且标明涉事事件与关系，上一版本保留', async () => {
  const draft = await req('GET', '/api/draft');
  const [a, b] = [draft.data.events[0].id, draft.data.events[1].id];
  const back = await req('POST', '/api/draft/relations', {
    predecessor_id: b, successor_id: a,
  });
  assert.equal(back.status, 201);

  const ca = draft.data.claims.find((c) => c.source === '访谈03-王氏族老').id;
  const cb = draft.data.claims.find((c) => c.source === '访谈07-李氏').id;
  const r = await req('POST', '/api/draft/publish', {
    baseVersionId: 1,
    selections: { [a]: ca, [b]: cb },
  });
  assert.equal(r.status, 422);
  assert.equal(r.data.result.cycles.length, 1);
  assert.ok(r.data.result.cycles[0].relations.length >= 2);

  const tl = await req('GET', '/api/timeline');
  assert.equal(tl.data.version.id, 1); // 上一版本保留
});

test('两名编辑者从同一版本发起修改：后提交者 409，重新确认后才发布', async () => {
  // 解除环
  const draft = await req('GET', '/api/draft');
  const rels = draft.data.relations;
  const backEdge = rels.find((r) =>
    r.predecessor_id === draft.data.events[1].id && r.successor_id === draft.data.events[0].id);
  await req('DELETE', `/api/draft/relations/${backEdge.id}`);

  // 编辑者甲：新增事件并基于版本 1 发布 -> 版本 2
  const full = await req('GET', '/api/draft');
  const ca = full.data.claims.find((c) => c.source === '访谈03-王氏族老').id;
  const cb = full.data.claims.find((c) => c.source === '访谈07-李氏').id;
  const [idA, idB] = [full.data.events[0].id, full.data.events[1].id];

  const e3 = (await req('POST', '/api/draft/events', { title: '甲新增事件' })).data.id;
  const c3 = (await req('POST', '/api/draft/claims', {
    event_id: e3, year: 1950, source: '甲的访谈01',
  })).data.id;

  const selectionsA = { [idA]: ca, [idB]: cb, [e3]: c3 };
  const pubA = await req('POST', '/api/draft/publish', {
    baseVersionId: 1, selections: selectionsA, note: '甲的发布',
  });
  assert.equal(pubA.status, 201);
  assert.equal(pubA.data.versionId, 2);

  // 编辑者乙：仍基于版本 1 提交 -> 409，响应中带最新年表，且不产生新版本
  const e4 = (await req('POST', '/api/draft/events', { title: '乙新增事件' })).data.id;
  const c4 = (await req('POST', '/api/draft/claims', {
    event_id: e4, year: 1951, source: '乙的访谈02',
  })).data.id;
  const selectionsB = { ...selectionsA, [e4]: c4 };
  const pubB = await req('POST', '/api/draft/publish', {
    baseVersionId: 1, selections: selectionsB, note: '乙的发布',
  });
  assert.equal(pubB.status, 409);
  assert.equal(pubB.data.conflict.currentVersion.id, 2);
  assert.equal(pubB.data.conflict.timeline.version.id, 2);

  const tl = await req('GET', '/api/timeline');
  assert.equal(tl.data.version.id, 2);

  // 乙重新确认，以版本 2 为基础发布
  const pubB2 = await req('POST', '/api/draft/publish', {
    baseVersionId: 2, selections: selectionsB, note: '乙重新确认后发布',
  });
  assert.equal(pubB2.status, 201);
  assert.equal(pubB2.data.versionId, 3);
  const tl2 = await req('GET', '/api/timeline');
  assert.equal(tl2.data.events.length, 4);
});

test('访客无法遍历历史版本接口', async () => {
  const r = await fetch(`${base}/api/versions`);
  assert.equal(r.status, 404);
});

test('非法日期返回 400', async () => {
  const draft = await req('GET', '/api/draft');
  const r = await req('POST', '/api/draft/claims', {
    event_id: draft.data.events[0].id, year: 1937, month: 2, day: 30, source: 'x',
  });
  assert.equal(r.status, 400);
});
