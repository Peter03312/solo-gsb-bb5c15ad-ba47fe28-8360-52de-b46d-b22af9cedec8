// 发布：把通过校验的草稿冻结为不可变版本快照。
// 乐观并发：发布须携带所依据的 baseVersionId；若已被他人抢先发布则拒绝（409）。

import { evaluateDraft } from './evaluate.js';
import { claimInterval, formatClaim, formatOrdinal } from './dates.js';

export class ConflictError extends Error {
  constructor(currentVersion, currentTimeline) {
    super('版本冲突：依据的已发布版本已不是最新版本');
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.currentVersion = currentVersion;
    this.currentTimeline = currentTimeline;
  }
}

export class ValidationError extends Error {
  constructor(result) {
    super('当前草稿无法发布');
    this.name = 'ValidationError';
    this.statusCode = 422;
    this.result = result;
  }
}

function loadDraft(db) {
  const events = db.all('SELECT * FROM draft_events ORDER BY id');
  const claims = db.all('SELECT * FROM draft_claims ORDER BY id');
  const relations = db.all('SELECT * FROM draft_relations ORDER BY id');
  return { events, claims, relations };
}

export function latestVersion(db) {
  return db.get('SELECT * FROM versions ORDER BY id DESC LIMIT 1');
}

/** 供访客使用的最新已发布年表；从未发布时返回 null（未发布内容不可见） */
export function getPublishedTimeline(db) {
  const version = latestVersion(db);
  if (!version) return null;
  const versionEvents = db.all(
    'SELECT * FROM version_events WHERE version_id = ? ORDER BY resolved_ordinal, event_id',
    [version.id]
  );
  const versionRelations = db.all(
    'SELECT * FROM version_relations WHERE version_id = ? ORDER BY relation_id',
    [version.id]
  );
  return { version, events: versionEvents, relations: versionRelations };
}

export function listVersions(db) {
  return db.all('SELECT * FROM versions ORDER BY id DESC');
}

/**
 * 评估当前草稿（不写库），供编辑界面实时显示阻塞问题。
 */
export function preview(db, selections) {
  const { events, claims, relations } = loadDraft(db);
  return evaluateDraft({ events, claims, relations, selections });
}

/**
 * 发布新版本。
 * @param baseVersionId 编辑者发起修改时所依据的版本（首次发布传 null）
 * @param selections    { eventId -> claimId }
 * @param note          版本说明
 */
export function publishVersion(db, { baseVersionId, selections, note }) {
  return db.transaction(() => {
    const current = latestVersion(db);
    const currentId = current ? current.id : null;
    const given = baseVersionId === undefined ? null : baseVersionId;
    if (given !== currentId) {
      throw new ConflictError(current, getPublishedTimeline(db));
    }

    const { events, claims, relations } = loadDraft(db);
    const result = evaluateDraft({ events, claims, relations, selections });
    if (!result.feasible) {
      throw new ValidationError(result);
    }

    const versionRes = db.run('INSERT INTO versions (note) VALUES (?)', [note ?? '']);
    const versionId = versionRes.lastInsertRowid;

    for (const e of events) {
      const claim = claims.find((c) => c.id === selections.get(e.id));
      const { lo, hi } = claimInterval(claim);
      db.run(
        `INSERT INTO version_events
           (version_id, event_id, title, description, claim_id,
            year, month, day, precision, source, note,
            ordinal_lo, ordinal_hi, resolved_ordinal)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          versionId,
          e.id,
          e.title,
          e.description,
          claim.id,
          claim.year,
          claim.month,
          claim.day,
          claim.precision,
          claim.source,
          claim.note,
          lo,
          hi,
          result.earliest.get(e.id),
        ]
      );
    }

    for (const r of relations) {
      db.run(
        `INSERT INTO version_relations
           (version_id, relation_id, predecessor_id, successor_id, note)
         VALUES (?,?,?,?,?)`,
        [versionId, r.id, r.predecessor_id, r.successor_id, r.note]
      );
    }

    return {
      versionId,
      events: events.map((e) => ({
        event_id: e.id,
        title: e.title,
        claim_label: formatClaim(claims.find((c) => c.id === selections.get(e.id))),
        resolved_date: formatOrdinal(result.earliest.get(e.id)),
      })),
    };
  });
}
