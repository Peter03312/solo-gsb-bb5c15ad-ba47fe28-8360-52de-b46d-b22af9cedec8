// SQLite 建表脚本。
// drafts_* 为编辑工作区（可改可删）；published_* 为发布快照（触发器禁止改/删）。

export const SCHEMA = `
PRAGMA foreign_keys = ON;

-- ============ 编辑工作区 ============

CREATE TABLE IF NOT EXISTS draft_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS draft_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  month       INTEGER,
  day         INTEGER,
  precision   TEXT NOT NULL CHECK (precision IN ('year','month','day')),
  source      TEXT NOT NULL,              -- 出处（访谈编号 / 档案 / 页码等）
  note        TEXT NOT NULL DEFAULT '',   -- 受访者、转述方式等备注
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS draft_relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  predecessor_id INTEGER NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  successor_id   INTEGER NOT NULL REFERENCES draft_events(id) ON DELETE CASCADE,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);

-- ============ 已发布版本（不可变） ============

CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  note        TEXT NOT NULL DEFAULT ''
  -- 不设 UPDATE/DELETE 触发器于本表自身无意义的字段；版本一旦生成即不可变，见下方触发器
);

CREATE TABLE IF NOT EXISTS version_events (
  version_id  INTEGER NOT NULL REFERENCES versions(id),
  event_id    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  claim_id    INTEGER NOT NULL,
  year        INTEGER NOT NULL,
  month       INTEGER,
  day         INTEGER,
  precision   TEXT NOT NULL,
  source      TEXT NOT NULL,
  note        TEXT NOT NULL,
  ordinal_lo  INTEGER NOT NULL,
  ordinal_hi  INTEGER NOT NULL,
  resolved_ordinal INTEGER NOT NULL,  -- 满足全部严格先后关系的具体日期
  PRIMARY KEY (version_id, event_id)
);

CREATE TABLE IF NOT EXISTS version_relations (
  version_id     INTEGER NOT NULL REFERENCES versions(id),
  relation_id    INTEGER NOT NULL,
  predecessor_id INTEGER NOT NULL,
  successor_id   INTEGER NOT NULL,
  note           TEXT NOT NULL,
  PRIMARY KEY (version_id, relation_id)
);

-- 不可变：版本表禁止 UPDATE / DELETE
CREATE TRIGGER IF NOT EXISTS versions_no_update
BEFORE UPDATE ON versions
BEGIN SELECT RAISE(ABORT, '已发布版本不可修改'); END;

CREATE TRIGGER IF NOT EXISTS versions_no_delete
BEFORE DELETE ON versions
BEGIN SELECT RAISE(ABORT, '已发布版本不可删除'); END;

CREATE TRIGGER IF NOT EXISTS version_events_no_update
BEFORE UPDATE ON version_events
BEGIN SELECT RAISE(ABORT, '已发布事件快照不可修改'); END;

CREATE TRIGGER IF NOT EXISTS version_events_no_delete
BEFORE DELETE ON version_events
BEGIN SELECT RAISE(ABORT, '已发布事件快照不可删除'); END;

CREATE TRIGGER IF NOT EXISTS version_relations_no_update
BEFORE UPDATE ON version_relations
BEGIN SELECT RAISE(ABORT, '已发布关系快照不可修改'); END;

CREATE TRIGGER IF NOT EXISTS version_relations_no_delete
BEFORE DELETE ON version_relations
BEGIN SELECT RAISE(ABORT, '已发布关系快照不可删除'); END;
`;
