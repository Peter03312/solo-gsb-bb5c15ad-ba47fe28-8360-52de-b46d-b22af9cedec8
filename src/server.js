import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { openDatabase } from './db.js';
import { normalizeClaimDate, formatOrdinal } from './dates.js';
import {
  publishVersion,
  preview,
  getPublishedTimeline,
  latestVersion,
} from './publish.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'chronicle.sqlite');
const EDITOR_TOKEN = process.env.EDITOR_TOKEN || '';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireEditor(req, res) {
  if (!EDITOR_TOKEN) return true;
  const token = req.headers['x-editor-token'];
  if (token !== EDITOR_TOKEN) {
    sendJson(res, 401, { error: '编辑口令缺失或不正确', authRequired: true });
    return false;
  }
  return true;
}

function eventExists(db, id) {
  return db.get('SELECT id FROM draft_events WHERE id = ?', [id]) !== null;
}

function decorateTimeline(timeline) {
  if (!timeline) return null;
  return {
    version: { id: timeline.version.id, created_at: timeline.version.created_at, note: timeline.version.note },
    events: timeline.events.map((e) => ({
      event_id: e.event_id,
      title: e.title,
      description: e.description,
      claim: {
        id: e.claim_id,
        year: e.year,
        month: e.month,
        day: e.day,
        precision: e.precision,
        source: e.source,
        note: e.note,
      },
      resolved_date: formatOrdinal(e.resolved_ordinal),
    })),
    relations: timeline.relations.map((r) => ({
      relation_id: r.relation_id,
      predecessor_id: r.predecessor_id,
      successor_id: r.successor_id,
      note: r.note,
    })),
  };
}

export function createApp(db) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method;

    try {
      // ---------- 静态页面 ----------
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        return serveStatic(res, 'index.html');
      }
      if (method === 'GET' && (path === '/editor' || path === '/editor.html')) {
        return serveStatic(res, 'editor.html');
      }
      if (method === 'GET' && /^\/(style\.css|app\.js|editor\.js|favicon\.ico)$/.test(path)) {
        return serveStatic(res, path.slice(1));
      }

      // ---------- 公开只读 API ----------
      if (method === 'GET' && path === '/api/config') {
        return sendJson(res, 200, { authRequired: Boolean(EDITOR_TOKEN) });
      }
      if (method === 'GET' && path === '/api/timeline') {
        return sendJson(res, 200, decorateTimeline(getPublishedTimeline(db)));
      }

      // ---------- 编辑草稿 API ----------
      if (path.startsWith('/api/draft')) {
        if (!requireEditor(req, res)) return;
        return await handleDraft(db, req, res, method, path);
      }

      sendJson(res, 404, { error: '未找到' });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, {
        error: err.message || '服务器内部错误',
        ...(err.result ? { result: serializeResult(err.result) } : {}),
        ...(err.currentVersion
          ? {
              conflict: {
                currentVersion: err.currentVersion
                  ? { id: err.currentVersion.id, created_at: err.currentVersion.created_at }
                  : null,
                timeline: decorateTimeline(err.currentTimeline),
              },
            }
          : {}),
      });
    }
  });

  async function serveStatic(res, name) {
    const filePath = normalize(join(PUBLIC_DIR, name));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(res, 403, { error: '禁止访问' });
    }
    const data = await readFile(filePath);
    const ext = name.slice(name.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  }
}

/** 把评估结果中的 Map/Infinity 转为 JSON 可序列化结构 */
function serializeResult(result) {
  return {
    feasible: result.feasible,
    empty: result.empty,
    missingSelections: result.missingSelections,
    invalidSelections: result.invalidSelections,
    cycles: result.cycles,
    unsatisfiable: result.unsatisfiable.map((u) => ({
      ...u,
      lower_bound: u.lower_bound === Infinity ? null : formatOrdinal(u.lower_bound),
      upper_bound: u.upper_bound === Infinity ? null : formatOrdinal(u.upper_bound),
    })),
  };
}

async function handleDraft(db, req, res, method, path) {
  const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readBody(req) : {};

  // 草稿总览：事件、主张、关系 + 当前已发布版本
  if (method === 'GET' && path === '/api/draft') {
    const version = latestVersion(db);
    return sendJson(res, 200, {
      baseVersion: version
        ? { id: version.id, created_at: version.created_at, note: version.note }
        : null,
      events: db.all('SELECT * FROM draft_events ORDER BY id'),
      claims: db.all('SELECT * FROM draft_claims ORDER BY id'),
      relations: db.all('SELECT * FROM draft_relations ORDER BY id'),
    });
  }

  // ---- 事件 ----
  if (method === 'POST' && path === '/api/draft/events') {
    const title = String(body.title ?? '').trim();
    if (!title) throw Object.assign(new Error('事件标题不能为空'), { statusCode: 400 });
    const r = db.run('INSERT INTO draft_events (title, description) VALUES (?, ?)', [
      title,
      String(body.description ?? '').trim(),
    ]);
    return sendJson(res, 201, { id: r.lastInsertRowid });
  }

  let m;
  if ((m = path.match(/^\/api\/draft\/events\/(\d+)$/))) {
    const id = Number(m[1]);
    if (!eventExists(db, id)) throw Object.assign(new Error('事件不存在'), { statusCode: 404 });
    if (method === 'PATCH') {
      const fields = [];
      const params = [];
      if (body.title !== undefined) {
        const title = String(body.title).trim();
        if (!title) throw Object.assign(new Error('事件标题不能为空'), { statusCode: 400 });
        fields.push('title = ?');
        params.push(title);
      }
      if (body.description !== undefined) {
        fields.push('description = ?');
        params.push(String(body.description).trim());
      }
      if (fields.length === 0) throw Object.assign(new Error('没有可更新字段'), { statusCode: 400 });
      params.push(id);
      db.run(`UPDATE draft_events SET ${fields.join(', ')} WHERE id = ?`, params);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      db.run('DELETE FROM draft_events WHERE id = ?', [id]);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 主张 ----
  if (method === 'POST' && path === '/api/draft/claims') {
    const eventId = Number(body.event_id);
    if (!Number.isInteger(eventId) || !eventExists(db, eventId)) {
      throw Object.assign(new Error('关联事件不存在'), { statusCode: 400 });
    }
    const normalized = normalizeClaimDate(body);
    if (normalized.error) {
      throw Object.assign(new Error(normalized.error), { statusCode: 400 });
    }
    const source = String(body.source ?? '').trim();
    if (!source) throw Object.assign(new Error('出处不能为空'), { statusCode: 400 });
    const r = db.run(
      'INSERT INTO draft_claims (event_id, year, month, day, precision, source, note) VALUES (?,?,?,?,?,?,?)',
      [
        eventId,
        normalized.year,
        normalized.month,
        normalized.day,
        normalized.precision,
        source,
        String(body.note ?? '').trim(),
      ]
    );
    return sendJson(res, 201, { id: r.lastInsertRowid });
  }

  if ((m = path.match(/^\/api\/draft\/claims\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'DELETE') {
      const claim = db.get('SELECT id FROM draft_claims WHERE id = ?', [id]);
      if (!claim) throw Object.assign(new Error('主张不存在'), { statusCode: 404 });
      db.run('DELETE FROM draft_claims WHERE id = ?', [id]);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- “先于”关系 ----
  if (method === 'POST' && path === '/api/draft/relations') {
    const predecessorId = Number(body.predecessor_id);
    const successorId = Number(body.successor_id);
    if (!Number.isInteger(predecessorId) || !Number.isInteger(successorId)) {
      throw Object.assign(new Error('请选择两个事件'), { statusCode: 400 });
    }
    if (predecessorId === successorId) {
      throw Object.assign(new Error('事件不能先于自身'), { statusCode: 400 });
    }
    if (!eventExists(db, predecessorId) || !eventExists(db, successorId)) {
      throw Object.assign(new Error('关联事件不存在'), { statusCode: 400 });
    }
    try {
      const r = db.run(
        'INSERT INTO draft_relations (predecessor_id, successor_id, note) VALUES (?,?,?)',
        [predecessorId, successorId, String(body.note ?? '').trim()]
      );
      return sendJson(res, 201, { id: r.lastInsertRowid });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw Object.assign(new Error('这两个事件之间已存在相同的先于关系'), { statusCode: 409 });
      }
      throw err;
    }
  }

  if ((m = path.match(/^\/api\/draft\/relations\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'DELETE') {
      const rel = db.get('SELECT id FROM draft_relations WHERE id = ?', [id]);
      if (!rel) throw Object.assign(new Error('关系不存在'), { statusCode: 404 });
      db.run('DELETE FROM draft_relations WHERE id = ?', [id]);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 校验（不落库） ----
  if (method === 'POST' && path === '/api/draft/validate') {
    const result = preview(db, normalizeSelections(body.selections));
    return sendJson(res, 200, serializeResult(result));
  }

  // ---- 发布 ----
  if (method === 'POST' && path === '/api/draft/publish') {
    const result = await publishVersion(db, {
      baseVersionId: body.baseVersionId === undefined ? null : body.baseVersionId,
      selections: normalizeSelections(body.selections),
      note: String(body.note ?? '').trim(),
    });
    return sendJson(res, 201, result);
  }

  throw Object.assign(new Error('接口不存在'), { statusCode: 404 });
}

function normalizeSelections(raw) {
  const selections = new Map();
  if (raw && typeof raw === 'object') {
    for (const [eventId, claimId] of Object.entries(raw)) {
      if (claimId === null || claimId === undefined || claimId === '') continue;
      selections.set(Number(eventId), Number(claimId));
    }
  }
  return selections;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await openDatabase(DB_PATH);
  const server = createApp(db);
  server.listen(PORT, HOST, () => {
    const port = server.address().port;
    const shownPort = port;
    const urlHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`年表应用已启动：http://${urlHost}:${shownPort}`);
    console.log(`  监听: http://${HOST}:${port}`);
    console.log(`  访客年表:  http://${urlHost}:${port}/`);
    console.log(`  编辑界面:  http://${urlHost}:${port}/editor`);
    console.log(`  数据库文件: ${DB_PATH}`);
    if (EDITOR_TOKEN) console.log('  已启用编辑口令（EDITOR_TOKEN）');
  });

  const shutdown = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
