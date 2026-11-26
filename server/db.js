import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';
import { parseDate } from './time.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','venue_admin','sys_admin')),
  enabled INTEGER NOT NULL DEFAULT 1,
  notify_site INTEGER NOT NULL DEFAULT 1,
  notify_reminder INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_grants (
  user_id TEXT NOT NULL REFERENCES users(id),
  room_id TEXT NOT NULL,
  granted_by TEXT,
  granted_at INTEGER,
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS business_permissions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  can_review INTEGER NOT NULL DEFAULT 0,
  can_stats INTEGER NOT NULL DEFAULT 0,
  can_rules INTEGER NOT NULL DEFAULT 0,
  can_audit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  building TEXT NOT NULL,
  floor TEXT NOT NULL,
  description TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  code TEXT NOT NULL,
  near_window INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, code)
);

CREATE TABLE IF NOT EXISTS seat_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_id TEXT NOT NULL REFERENCES seats(id),
  room_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  changed_at INTEGER NOT NULL,
  actor_id TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_seat_status_seat ON seat_status_history (seat_id, changed_at, id);

CREATE TABLE IF NOT EXISTS facilities (
  seat_id TEXT NOT NULL REFERENCES seats(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','faulty')),
  note TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (seat_id, kind)
);

CREATE TABLE IF NOT EXISTS facility_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  actor_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_maps (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS open_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  version INTEGER NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, date)
);

CREATE TABLE IF NOT EXISTS open_plan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER,
  end_min INTEGER,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  actor_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suspensions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','restored')),
  impact_hash TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  restored_at INTEGER,
  restored_by TEXT,
  restore_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_suspensions_seat ON suspensions (seat_id, start_ts, end_ts);

CREATE TABLE IF NOT EXISTS rule_versions (
  id TEXT PRIMARY KEY,
  advance_days INTEGER NOT NULL,
  checkin_grace_min INTEGER NOT NULL,
  away_minutes INTEGER NOT NULL,
  min_minutes INTEGER NOT NULL,
  daily_count INTEGER NOT NULL,
  daily_minutes INTEGER NOT NULL,
  effective_from INTEGER NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  room_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','using','away','cancelled','completed','no_show','aborted')),
  rule_version_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  checkin_deadline INTEGER NOT NULL,
  need_power INTEGER NOT NULL DEFAULT 0,
  checkin_protection_id TEXT,
  checkin_protected_until INTEGER,
  released_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  cancel_reason TEXT,
  first_checkin_at INTEGER,
  first_checkin_method TEXT,
  checkout_at INTEGER,
  waived INTEGER NOT NULL DEFAULT 0,
  swap_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_res_user ON reservations (user_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_res_room ON reservations (room_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations (status, checkin_deadline);

CREATE TABLE IF NOT EXISTS reservation_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  seat_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_seg_res ON reservation_segments (reservation_id);
CREATE INDEX IF NOT EXISTS idx_seg_seat ON reservation_segments (seat_id, start_ts, end_ts);

CREATE TABLE IF NOT EXISTS usage_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  seat_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_res ON usage_segments (reservation_id);
CREATE INDEX IF NOT EXISTS idx_usage_start ON usage_segments (start_ts);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  at_ts INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('self_qr','admin_assist')),
  seat_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS away_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  start_ts INTEGER NOT NULL,
  deadline_ts INTEGER NOT NULL,
  returned_at INTEGER,
  closed_at INTEGER,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_away_res ON away_records (reservation_id);

CREATE TABLE IF NOT EXISTS seat_changes (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  from_seat_id TEXT NOT NULL,
  to_seat_id TEXT NOT NULL,
  at_ts INTEGER NOT NULL,
  need_power INTEGER NOT NULL DEFAULT 0,
  preference TEXT,
  operator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS route_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entrance_id TEXT,
  map_version INTEGER,
  distance_m REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_views_res ON route_views (reservation_id);

CREATE TABLE IF NOT EXISTS violations (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  reservation_id TEXT,
  occurred_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  material TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','effective','revoked')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_reason TEXT,
  revoked_by TEXT,
  revoked_at INTEGER,
  revoke_reason TEXT,
  rule_version_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_viol_user ON violations (user_id, status);

CREATE TABLE IF NOT EXISTS limits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  room_scope TEXT NOT NULL DEFAULT 'ALL',
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_limits_user ON limits (user_id, start_ts, end_ts);

CREATE TABLE IF NOT EXISTS limit_basis (
  limit_id TEXT NOT NULL REFERENCES limits(id),
  violation_id TEXT NOT NULL REFERENCES violations(id),
  PRIMARY KEY (limit_id, violation_id)
);

CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('facility','service','appeal')),
  description TEXT NOT NULL,
  reservation_id TEXT,
  violation_id TEXT,
  is_site INTEGER NOT NULL DEFAULT 0,
  is_occupancy INTEGER NOT NULL DEFAULT 0,
  seat_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','answered','closed')),
  assignee_id TEXT,
  accused_id TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  replied_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_complaints_user ON complaints (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_complaints_room ON complaints (room_id, status);

CREATE TABLE IF NOT EXISTS complaint_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id TEXT NOT NULL REFERENCES complaints(id),
  kind TEXT NOT NULL,
  author_id TEXT,
  body TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_complaint_events ON complaint_events (complaint_id);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  content TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden')),
  hidden_reason TEXT,
  hidden_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS faults (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  function TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  description TEXT,
  verified INTEGER NOT NULL DEFAULT 1,
  verified_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faults_room ON faults (room_id, start_ts, end_ts);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  read_at INTEGER,
  UNIQUE (user_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at);

CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_created ON audits (created_at);

CREATE TABLE IF NOT EXISTS idempotency (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`);

const reservationColumns = db.prepare('PRAGMA table_info(reservations)').all().map((column) => column.name);
if (!reservationColumns.includes('need_power')) {
  db.exec('ALTER TABLE reservations ADD COLUMN need_power INTEGER NOT NULL DEFAULT 0');
}
if (!reservationColumns.includes('checkin_protection_id')) {
  db.exec('ALTER TABLE reservations ADD COLUMN checkin_protection_id TEXT');
}
if (!reservationColumns.includes('checkin_protected_until')) {
  db.exec('ALTER TABLE reservations ADD COLUMN checkin_protected_until INTEGER');
}
if (!db.prepare('PRAGMA table_info(complaints)').all().some((column) => column.name === 'is_occupancy')) {
  db.exec('ALTER TABLE complaints ADD COLUMN is_occupancy INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('PRAGMA table_info(seats)').all().some((column) => column.name === 'archived_at')) {
  db.exec('ALTER TABLE seats ADD COLUMN archived_at INTEGER');
}

/**
 * 为升级前的既有座位补一条“生效起点”记录。
 * 旧版本没有座位生命周期，统计一律按当前未归档座位计算；这里以场地最早的计划/预约时间
 * 作为起点，保证升级当次的历史统计不会被清零，后续创建、归档、恢复则按真实时刻记入。
 */
function backfillSeatStatusHistory() {
  const seats = db
    .prepare(
      `SELECT s.* FROM seats s
        WHERE NOT EXISTS (SELECT 1 FROM seat_status_history h WHERE h.seat_id = s.id)`,
    )
    .all();
  if (!seats.length) return;
  const insert = db.prepare(
    `INSERT INTO seat_status_history (seat_id, room_id, status, changed_at, actor_id, reason)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  );
  const roomStmt = db.prepare('SELECT created_at FROM rooms WHERE id = ?');
  const planStmt = db.prepare('SELECT MIN(date) AS date FROM open_plans WHERE room_id = ?');
  const reservationStmt = db.prepare('SELECT MIN(start_ts) AS start_ts FROM reservations WHERE room_id = ?');
  for (const seat of seats) {
    const room = roomStmt.get(seat.room_id);
    const planDate = planStmt.get(seat.room_id)?.date;
    const reservationStart = reservationStmt.get(seat.room_id)?.start_ts;
    const starts = [seat.created_at, room?.created_at, planDate ? parseDate(planDate) : null, reservationStart]
      .filter((value) => value != null);
    const activeFrom = Math.min(...starts);
    insert.run(seat.id, seat.room_id, 'active', activeFrom, '历史数据回填：座位生效起点');
    if (seat.archived) {
      const archivedAt = seat.archived_at ?? Date.now();
      if (archivedAt >= activeFrom) {
        insert.run(seat.id, seat.room_id, 'archived', archivedAt, '历史数据回填：当前归档状态');
      }
    }
  }
}

backfillSeatStatusHistory();

let depth = 0;
let savepointSeq = 0;

/** 同步事务：支持嵌套（嵌套时使用 SAVEPOINT）。所有写操作均应置于事务中。 */
function tx(fn) {
  if (depth > 0) {
    const sp = `sp_${(savepointSeq += 1)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth += 1;
  try {
    const result = fn();
    depth -= 1;
    db.exec('COMMIT');
    return result;
  } catch (err) {
    depth -= 1;
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function metaGet(key, fallback = null) {
  const row = get('SELECT value FROM meta WHERE key = ?', key);
  return row ? row.value : fallback;
}

function metaSet(key, value) {
  run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value),
  );
}

/** 生成可读业务编号，如 RSV-20261106-0001 */
function nextId(prefix, name, width = 4) {
  return tx(() => {
    const key = `counter:${name}`;
    const current = Number(metaGet(key, '0')) + 1;
    metaSet(key, current);
    return `${prefix}-${current.toString().padStart(width, '0')}`;
  });
}

export { db, tx, get, all, run, metaGet, metaSet, nextId };
