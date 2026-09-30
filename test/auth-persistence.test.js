import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
let proc;
let base;
let logs = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chronicle-'));
  const dbPath = join(dir, 'test.sqlite');
  proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      EDITOR_TOKEN: 'secret123',
    },
  });
  proc.stdout.on('data', (d) => {
    logs += d;
    const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m && !base) base = `http://127.0.0.1:${m[1]}`;
  });
  proc.stderr.on('data', (d) => { logs += d; });

  const deadline = Date.now() + 8000;
  while (!base && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!base) throw new Error('服务器未在限定时间内启动。日志：\n' + logs);
});

after(async () => {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  await rm(dir, { recursive: true, force: true });
});

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

test('启用口令后：无口令/错误口令被拒，访客只读不受影响', async () => {
  const config = await req('GET', '/api/config');
  assert.equal(config.data.authRequired, true);

  const noToken = await req('GET', '/api/draft');
  assert.equal(noToken.status, 401);

  const wrong = await req('GET', '/api/draft', undefined, 'nope');
  assert.equal(wrong.status, 401);

  const tl = await req('GET', '/api/timeline');
  assert.equal(tl.status, 200);
});

test('正确口令可编辑发布，且数据落盘为 SQLite 文件；重启后仍在', async () => {
  const e = await req('POST', '/api/draft/events', { title: '落盘事件' }, 'secret123');
  assert.equal(e.status, 201);
  const c = await req('POST', '/api/draft/claims', {
    event_id: e.data.id, year: 1949, source: '档案01',
  }, 'secret123');
  assert.equal(c.status, 201);
  const pub = await req('POST', '/api/draft/publish', {
    baseVersionId: null,
    selections: { [e.data.id]: c.data.id },
  }, 'secret123');
  assert.equal(pub.status, 201);

  // SQLite 文件头魔数 "SQLite format 3\0"
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  const buf = await readFile(join(dir, 'test.sqlite'));
  assert.equal(buf.subarray(0, 16).toString('latin1'), 'SQLite format 3\x00');

  // 重启同一数据库文件
  let logs2 = '';
  let base2 = '';
  const proc2 = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DB_PATH: join(dir, 'test.sqlite'), EDITOR_TOKEN: 'secret123' },
  });
  proc2.stdout.on('data', (d) => {
    logs2 += d;
    const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m && !base2) base2 = `http://127.0.0.1:${m[1]}`;
  });
  const deadline = Date.now() + 8000;
  while (!base2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!base2) throw new Error('重启失败：\n' + logs2);

  const res = await fetch(base2 + '/api/timeline');
  const tl = await res.json();
  assert.equal(tl.version.id, 1);
  assert.equal(tl.events[0].title, '落盘事件');
  assert.equal(tl.events[0].claim.source, '档案01');

  proc2.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
});
