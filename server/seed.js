import { db, get, run, tx, metaGet, metaSet, nextId } from './db.js';
import { hashPassword } from './auth.js';
import { buildLayout } from './roommap.js';
import { isDemo, now, syncToRealTime } from './clock.js';
import { dateStr, addDaysLocal, parseDate, MINUTE } from './time.js';
import { currentRule } from './services/shared.js';

const DEMO_ROOM_PLANS = [
  ['R1', 8 * 60, 22 * 60, '学期常规开放：08:00—22:00'],
  ['R2', 9 * 60, 21 * 60, '学期常规开放：09:00—21:00'],
];

const TABLES = [
  'route_views',
  'seat_changes',
  'usage_segments',
  'reservation_segments',
  'checkins',
  'away_records',
  'reservations',
  'limit_basis',
  'limits',
  'violations',
  'complaint_events',
  'complaints',
  'evaluation_history',
  'evaluations',
  'faults',
  'notifications',
  'idempotency',
  'sessions',
  'facilities',
  'facility_history',
  'seat_status_history',
  'seats',
  'open_plan_history',
  'open_plans',
  'suspensions',
  'room_maps',
  'room_grants',
  'business_permissions',
  'rule_versions',
  'audits',
  'users',
  'rooms',
  'meta',
];

function resetDatabase() {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of TABLES) {
    try {
      db.exec(`DELETE FROM ${table}`);
    } catch {
      /* table may not exist yet */
    }
  }
  try {
    db.exec('DELETE FROM sqlite_sequence');
  } catch {
    /* ignore */
  }
  db.exec('PRAGMA foreign_keys = ON');
  syncToRealTime();
}

function addUser(txTime, { id, username, displayName, role, grants = [], permissions = {}, passwordHash = null }) {
  run(
    `INSERT INTO users (id, username, display_name, password_hash, role, enabled, notify_site, notify_reminder, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
    id,
    username,
    displayName,
    passwordHash || hashPassword('123456'),
    role,
    txTime,
    txTime,
  );
  for (const roomId of grants) {
    run(
      'INSERT INTO room_grants (user_id, room_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
      id,
      roomId,
      'S1',
      txTime,
    );
  }
  run(
    'INSERT INTO business_permissions (user_id, can_review, can_stats, can_rules, can_audit) VALUES (?, ?, ?, ?, ?)',
    id,
    permissions.canReview ? 1 : 0,
    permissions.canStats ? 1 : 0,
    permissions.canRules ? 1 : 0,
    permissions.canAudit ? 1 : 0,
  );
}

function addRoom(ts, { id, name, building, floor, description, codes, faultyCodes = [] }) {
  run(
    'INSERT INTO rooms (id, name, building, floor, description, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    id,
    name,
    building,
    floor,
    description,
    ts,
  );
  // 演示数据包含近 7 天历史记录，座位生效起点须早于这些记录，避免历史分母被当成 0。
  const seatCreatedAt = ts - 31 * 24 * 60 * MINUTE;
  const half = Math.ceil(codes.length / 2);
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    const seatId = `${id}-${code}`;
    run(
      'INSERT INTO seats (id, room_id, code, near_window, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      seatId,
      id,
      code,
      i < half ? 1 : 0,
      seatCreatedAt,
    );
    run(
      `INSERT INTO seat_status_history (seat_id, room_id, status, changed_at, actor_id, reason)
       VALUES (?, ?, 'active', ?, 'M1', '演示数据：座位初始生效')`,
      seatId,
      id,
      seatCreatedAt,
    );
    const faulty = faultyCodes.includes(code);
    run(
      'INSERT INTO facilities (seat_id, kind, status, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      seatId,
      'power',
      faulty ? 'faulty' : 'normal',
      faulty ? '现场核实：桌面插座无电，已报修' : '部署前核对：插座正常',
      'M1',
      ts - 2 * 24 * 60 * MINUTE,
    );
    if (faulty) {
      run(
        'INSERT INTO facility_history (seat_id, kind, status, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        seatId,
        'power',
        'faulty',
        '现场核实：桌面插座无电，已报修',
        'M1',
        ts - 2 * 24 * 60 * MINUTE,
      );
    }
  }
  const nearWindow = codes.slice(0, half);
  const layout = buildLayout(codes, { nearWindowCodes: nearWindow });
  layout.roomId = id;
  layout.version = 1;
  run(
    'INSERT INTO room_maps (room_id, version, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)',
    id,
    1,
    JSON.stringify(layout),
    ts,
    'M1',
  );
}

function addPlans(ts, [roomId, startMin, endMin, note], fromDate, days) {
  let version = (get('SELECT MAX(version) AS v FROM open_plans WHERE room_id = ?', roomId).v || 0) + 1;
  for (let i = 0; i < days; i += 1) {
    const date = addDaysLocal(fromDate, i);
    const { changes } = run(
      `INSERT INTO open_plans (room_id, date, start_min, end_min, version, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'M1', ?)
       ON CONFLICT(room_id, date) DO NOTHING`,
      roomId,
      date,
      startMin,
      endMin,
      version,
      note,
      ts,
    );
    version += changes;
  }
}

let demoPlanWindow;

/** 仅为演示场地补齐当前预约窗口内尚未发布的开放计划。 */
function ensureDemoOpenPlans(ts = now()) {
  if (!isDemo()) return;
  const today = dateStr(ts);
  const days = currentRule(ts)?.advance_days;
  const window = `${today}:${days}`;
  if (!days || window === demoPlanWindow || !metaGet('seed_version')) return;
  tx(() => {
    for (const plan of DEMO_ROOM_PLANS) {
      if (get('SELECT 1 FROM rooms WHERE id = ? AND archived = 0', plan[0])) {
        addPlans(ts, plan, today, days);
      }
    }
  });
  demoPlanWindow = window;
}

function historyReservation({
  ts,
  roomId,
  seatCode,
  userId,
  date,
  startMin,
  endMin,
  status = 'completed',
  evaluated = false,
  rating = 5,
}) {
  const dayStart = parseDate(date);
  const startTs = dayStart + startMin * MINUTE;
  const endTs = dayStart + endMin * MINUTE;
  const deadline = Math.min(startTs + 15 * MINUTE, endTs);
  const id = nextId('RSV', 'reservation', 4);
  const createdAt = startTs - 10 * MINUTE;
  const seatId = `${roomId}-${seatCode}`;
  if (status === 'no_show') {
    run(
      `INSERT INTO reservations (id, user_id, room_id, seat_id, start_ts, end_ts, status, rule_version_id, created_at, checkin_deadline, released_at, ended_at, end_reason)
       VALUES (?, ?, ?, ?, ?, ?, 'no_show', 'RV-1', ?, ?, ?, ?, 'no_show')`,
      id,
      userId,
      roomId,
      seatId,
      startTs,
      endTs,
      createdAt,
      deadline,
      deadline,
      deadline,
    );
    run(
      'INSERT INTO reservation_segments (reservation_id, seat_id, start_ts, end_ts, created_at, closed_reason) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      seatId,
      startTs,
      endTs,
      createdAt,
      'no_show',
    );
    const violationId = nextId('V', 'violation', 4);
    run(
      `INSERT INTO violations (id, event_key, user_id, room_id, reservation_id, occurred_at, type, material, status, created_by, created_at, rule_version_id)
       VALUES (?, ?, ?, ?, ?, ?, 'no_show', ?, 'pending', 'system', ?, 'RV-1')`,
      violationId,
      `no_show:${id}`,
      userId,
      roomId,
      id,
      deadline,
      '签到截止时仍未完成签到，由系统自动记录',
      deadline + MINUTE,
    );
    return { id, violationId };
  }
  const checkin = startTs + 5 * MINUTE;
  const checkout = endTs - 10 * MINUTE;
  run(
    `INSERT INTO reservations (id, user_id, room_id, seat_id, start_ts, end_ts, status, rule_version_id, created_at, checkin_deadline, released_at, ended_at, end_reason, first_checkin_at, first_checkin_method, checkout_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', 'RV-1', ?, ?, ?, ?, 'self_checkout', ?, 'self_qr', ?)`,
    id,
    userId,
    roomId,
    seatId,
    startTs,
    endTs,
    createdAt,
    deadline,
    checkout,
    checkout,
    checkin,
    checkout,
  );
  run(
    'INSERT INTO reservation_segments (reservation_id, seat_id, start_ts, end_ts, created_at, closed_reason) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    seatId,
    startTs,
    endTs,
    createdAt,
    'completed',
  );
  run(
    'INSERT INTO usage_segments (reservation_id, seat_id, start_ts, end_ts, close_reason) VALUES (?, ?, ?, ?, ?)',
    id,
    seatId,
    checkin,
    checkout,
    'checkout',
  );
  run(
    `INSERT INTO checkins (reservation_id, at_ts, method, seat_id, operator_id) VALUES (?, ?, 'self_qr', ?, ?)`,
    id,
    checkin,
    seatId,
    userId,
  );
  if (evaluated) {
    const evaluationId = nextId('EV', 'evaluation', 4);
    run(
      `INSERT INTO evaluations (id, reservation_id, user_id, room_id, rating, content, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'visible', ?, ?)`,
      evaluationId,
      id,
      userId,
      roomId,
      rating,
      '座位安静、采光良好，签到流程顺畅。',
      checkout + 10 * MINUTE,
      checkout + 10 * MINUTE,
    );
    run(
      `INSERT INTO evaluation_history (evaluation_id, rating, content, visibility, action, actor_id, created_at)
       VALUES (?, ?, ?, 'visible', 'create', ?, ?)`,
      evaluationId,
      rating,
      '座位安静、采光良好，签到流程顺畅。',
      userId,
      checkout + 10 * MINUTE,
    );
  }
  return { id };
}


/** 性能演示数据（可选）：R3 500 个座位 + 1 万条历史预约，用于 QR-01/02 压测。 */
function seedPerf(ts, today) {
  run(
    'INSERT INTO rooms (id, name, building, floor, description, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    'R3',
    '性能测试自习室',
    '测试楼',
    '五层',
    '500 个座位与 1 万条历史预约，用于性能与统计验证；不配置二维地图。',
    ts,
  );
  const seatCreatedAt = ts - 31 * 24 * 60 * MINUTE;
  for (let i = 1; i <= 500; i += 1) {
    const code = `P${String(i).padStart(3, '0')}`;
    const seatId = `R3-${code}`;
    run(
      'INSERT INTO seats (id, room_id, code, near_window, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      seatId,
      'R3',
      code,
      i <= 250 ? 1 : 0,
      seatCreatedAt,
    );
    run(
      `INSERT INTO seat_status_history (seat_id, room_id, status, changed_at, actor_id, reason)
       VALUES (?, 'R3', 'active', ?, 'M1', '性能数据：座位初始生效')`,
      seatId,
      seatCreatedAt,
    );
    run(
      'INSERT INTO facilities (seat_id, kind, status, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      seatId,
      'power',
      'normal',
      '性能数据集：插座正常',
      'M1',
      ts,
    );
  }
  addPlans(ts, ['R3', 7 * 60, 22 * 60, '性能测试计划'], addDaysLocal(today, -30), 37);
  addUser(ts, {
    id: 'M3',
    username: 'perf_m3',
    displayName: '性能测试管理员',
    role: 'venue_admin',
    grants: ['R3'],
    permissions: { canStats: true },
  });
  const slotStarts = [8 * 60, 10 * 60, 13 * 60, 15 * 60];
  for (let i = 0; i < 10000; i += 1) {
    const seatCode = `P${String((i % 500) + 1).padStart(3, '0')}`;
    const seatId = `R3-${seatCode}`;
    const slot = Math.floor(i / 500) % 4;
    const dayOffset = -1 - (Math.floor(i / 2000) % 30);
    const date = addDaysLocal(today, dayOffset);
    const dayStart = parseDate(date);
    const startTs = dayStart + slotStarts[slot] * MINUTE;
    const endTs = startTs + 90 * MINUTE;
    const checkin = startTs + 5 * MINUTE;
    const checkout = endTs - 5 * MINUTE;
    const userId = ['U01', 'U02', 'U03'][i % 3];
    const id = `RSV-P${String(i + 1).padStart(5, '0')}`;
    run(
      `INSERT INTO reservations (id, user_id, room_id, seat_id, start_ts, end_ts, status, rule_version_id, created_at, checkin_deadline, released_at, ended_at, end_reason, first_checkin_at, first_checkin_method, checkout_at)
       VALUES (?, ?, 'R3', ?, ?, ?, 'completed', 'RV-1', ?, ?, ?, ?, 'self_checkout', ?, 'self_qr', ?)`,
      id,
      userId,
      seatId,
      startTs,
      endTs,
      startTs - 30 * MINUTE,
      startTs + 15 * MINUTE,
      checkout,
      checkout,
      checkin,
      checkout,
    );
    run(
      'INSERT INTO reservation_segments (reservation_id, seat_id, start_ts, end_ts, created_at, closed_reason) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      seatId,
      startTs,
      endTs,
      startTs - 30 * MINUTE,
      'completed',
    );
    run(
      'INSERT INTO usage_segments (reservation_id, seat_id, start_ts, end_ts, close_reason) VALUES (?, ?, ?, ?, ?)',
      id,
      seatId,
      checkin,
      checkout,
      'checkout',
    );
    run(
      `INSERT INTO checkins (reservation_id, at_ts, method, seat_id, operator_id) VALUES (?, ?, 'self_qr', ?, ?)`,
      id,
      checkin,
      seatId,
      userId,
    );
  }
}

function seed({ reset = false, perf = false } = {}) {
  if (reset) resetDatabase();
  if (get('SELECT COUNT(*) AS n FROM users').n > 0) {
    return { seeded: false, reason: '数据库已有数据' };
  }
  const ts = now();
  syncToRealTime();
  const today = dateStr(ts);
  const from = addDaysLocal(today, -7);

  tx(() => {
    run(
      `INSERT INTO rule_versions (id, advance_days, checkin_grace_min, away_minutes, min_minutes, daily_count, daily_minutes, effective_from, note, created_by, created_at)
       VALUES ('RV-1', 7, 15, 15, 30, 4, 240, ?, 'DEMO-1 首版规则：提前 7 个日期、签到宽限 15 分钟、暂离 15 分钟、单次至少 30 分钟、每日 4 次 / 240 分钟', 'S1', ?)`,
      ts - 30 * 24 * 60 * MINUTE,
      ts - 30 * 24 * 60 * MINUTE,
    );

    addUser(ts, { id: 'U01', username: 'u01', displayName: '俞烨涛', role: 'student' });
    addUser(ts, { id: 'U02', username: 'u02', displayName: '林月', role: 'student' });
    addUser(ts, { id: 'U03', username: 'u03', displayName: '方梓安', role: 'student' });
    addUser(ts, {
      id: 'M1',
      username: 'm1',
      displayName: '金施成',
      role: 'venue_admin',
      grants: ['R1'],
      permissions: { canReview: true },
    });
    addUser(ts, {
      id: 'M2',
      username: 'm2',
      displayName: '钱瑾',
      role: 'venue_admin',
      grants: ['R2'],
      permissions: { canReview: true },
    });
    addUser(ts, {
      id: 'S1',
      username: 's1',
      displayName: '刘洁',
      role: 'sys_admin',
      permissions: { canRules: true, canAudit: true, canReview: true, canStats: true },
    });

    // 历史数据使用的合成学生
    const historyHash = hashPassword('123456');
    const extraStudents = [
      ['U04', '杨晨'],
      ['U05', '方梓谦'],
      ['U06', '王璇'],
      ['U07', '司马晨'],
      ['U08', '陈运龙'],
      ['U09', '王超'],
      ['U10', '钟啸'],
      ['U11', '胡术淇'],
    ];
    for (const [id, displayName] of extraStudents) {
      addUser(ts, {
        id,
        username: id.toLowerCase(),
        displayName,
        role: 'student',
        passwordHash: historyHash,
      });
    }

    addRoom(ts, {
      id: 'R1',
      name: '图书馆二层',
      building: '真诚图书馆',
      floor: '二层',
      description: '安静学习区，西、东两侧均有入口，北侧靠窗。',
      codes: Array.from({ length: 16 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`),
      faultyCodes: ['A06', 'A11'],
    });
    addRoom(ts, {
      id: 'R2',
      name: '图书馆三层',
      building: '真诚图书馆',
      floor: '三层',
      description: '小组讨论与自习混合区域。',
      codes: Array.from({ length: 8 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`),
    });

    for (const plan of DEMO_ROOM_PLANS) addPlans(ts, plan, from, 14);

    // 今日停用样例：A03 13:00—17:00 设施检修
    const todayStart = parseDate(today);
    const suspensionId = nextId('SUS', 'suspension', 4);
    run(
      `INSERT INTO suspensions (id, room_id, seat_id, start_ts, end_ts, reason, status, impact_hash, created_by, created_at)
       VALUES (?, 'R1', 'R1-A03', ?, ?, '设施检修：桌面插座与桌面照明检修', 'active', 'seed', 'M1', ?)`,
      suspensionId,
      todayStart + 13 * 60 * MINUTE,
      todayStart + 17 * 60 * MINUTE,
      ts - 24 * 60 * MINUTE,
    );

    // 近 7 天历史使用数据：R1 约 28%，R2 约 25%，用于统计趋势
    const r1Codes = Array.from({ length: 11 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
    const r2Codes = Array.from({ length: 8 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`);
    const r1Users = Array.from({ length: 11 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`);
    const r2Users = Array.from({ length: 8 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`);
    const morning = { start: 9 * 60, end: 12 * 60 };
    const afternoon = { start: 13 * 60, end: 16 * 60 };
    const evening = { start: 18 * 60, end: 20 * 60 + 30 };
    for (let daysAgo = 7; daysAgo >= 1; daysAgo -= 1) {
      const date = addDaysLocal(today, -daysAgo);
      // R1：上午、下午各 11 个座位
      for (let i = 0; i < 11; i += 1) {
        historyReservation({
          ts, roomId: 'R1', seatCode: r1Codes[i], userId: r1Users[i], date,
          startMin: morning.start, endMin: morning.end,
          evaluated: i < 3 && (daysAgo + i) % 2 === 0, rating: 3 + ((daysAgo + i) % 3),
        });
        historyReservation({
          ts, roomId: 'R1', seatCode: r1Codes[i], userId: r1Users[i], date,
          startMin: afternoon.start, endMin: afternoon.end,
          evaluated: i < 3 && daysAgo % 3 === 0, rating: 3 + ((daysAgo + i) % 3),
        });
      }
      // R2：傍晚前 4 个座位、晚间 8 个座位
      for (let i = 0; i < 4; i += 1) {
        historyReservation({
          ts, roomId: 'R2', seatCode: r2Codes[i], userId: r2Users[i], date,
          startMin: 16 * 60, endMin: 17 * 60 + 30,
        });
      }
      for (let i = 0; i < 8; i += 1) {
        historyReservation({
          ts, roomId: 'R2', seatCode: r2Codes[i], userId: r2Users[i], date,
          startMin: evening.start, endMin: evening.end,
          evaluated: (daysAgo + i) % 13 === 0, rating: 4,
        });
      }
    }
    // 一条爽约样例（三天前，产生待复核事件；与其他历史预约不重叠）
    const noShowDate = addDaysLocal(today, -3);
    historyReservation({
      ts, roomId: 'R1', seatCode: 'A05', userId: 'U11', date: noShowDate,
      startMin: 16 * 60 + 30, endMin: 17 * 60 + 30, status: 'no_show',
    });
    // 演示投诉（待受理）：U02 对 R1 设施问题的反馈
    const complaintId = nextId('C', 'complaint', 4);
    run(
      `INSERT INTO complaints (id, user_id, room_id, type, description, is_site, status, created_at)
       VALUES (?, 'U02', 'R1', 'facility', ?, 0, 'pending', ?)`,
      complaintId,
      'A12 座位的桌面插座接触不良，手机充电时断时续，希望安排检修。',
      ts - 3 * 60 * MINUTE,
    );
    run(
      `INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, 'submit', 'U02', ?, ?)`,
      complaintId,
      'A12 座位的桌面插座接触不良，手机充电时断时续，希望安排检修。',
      ts - 3 * 60 * MINUTE,
    );

    // 更多投诉样例，覆盖处理中 / 已答复状态
    const complaint2 = nextId('C', 'complaint', 4);
    run(
      `INSERT INTO complaints (id, user_id, room_id, type, description, is_site, status, assignee_id, created_at, accepted_at, replied_at)
       VALUES (?, 'U03', 'R2', 'facility', ?, 0, 'answered', 'M2', ?, ?, ?)`,
      complaint2,
      'B05 附近空调出风较小，下午时段较闷，希望调整。',
      ts - 26 * 60 * MINUTE,
      ts - 25 * 60 * MINUTE,
      ts - 24 * 60 * MINUTE,
    );
    run(`INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, 'submit', 'U03', ?, ?)`,
      complaint2, 'B05 附近空调出风较小，下午时段较闷，希望调整。', ts - 26 * 60 * MINUTE);
    run(`INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, 'accept', 'M2', ?, ?)`,
      complaint2, '已受理，联系物业检查。', ts - 25 * 60 * MINUTE);
    run(`INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, 'reply', 'M2', ?, ?)`,
      complaint2, '已调整该区域空调出风角度，请查看是否改善。', ts - 24 * 60 * MINUTE);

    const complaint3 = nextId('C', 'complaint', 4);
    run(
      `INSERT INTO complaints (id, user_id, room_id, type, description, is_site, status, assignee_id, created_at, accepted_at)
       VALUES (?, 'U01', 'R1', 'service', ?, 0, 'processing', 'M1', ?, ?)`,
      complaint3,
      '周末下午自习室入口附近有人长时间讨论，影响安静环境。',
      ts - 5 * 60 * MINUTE,
      ts - 4 * 60 * MINUTE,
    );
    run(`INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, 'submit', 'U01', ?, ?)`,
      complaint3, '周末下午自习室入口附近有人长时间讨论，影响安静环境。', ts - 5 * 60 * MINUTE);
    run(`INSERT INTO complaint_events (complaint_id, kind, author_id, body, created_at) VALUES (?, 'accept', 'M1', ?, ?)`,
      complaint3, '已受理，将到现场核实。', ts - 4 * 60 * MINUTE);

    // 过去已解除的限制样例：U03 两周前因爽约产生的限制（已过期）
    const vId = nextId('V', 'violation', 4);
    const pastOccurred = ts - 10 * 24 * 60 * MINUTE;
    run(
      `INSERT INTO violations (id, event_key, user_id, room_id, occurred_at, type, material, status, created_by, created_at, decided_by, decided_at, decision_reason)
       VALUES (?, ?, 'U03', 'R1', ?, 'site_event', ?, 'effective', 'M1', ?, 'M1', ?, ?)`,
      vId,
      `seed-manual-${vId}`,
      pastOccurred,
      '现场登记：离开时未清理桌面并遗留大量垃圾，管理员现场核实。',
      pastOccurred + 30 * MINUTE,
      pastOccurred + 2 * 60 * MINUTE,
      '现场照片与巡查记录一致，事实成立。',
    );
    const limitId = nextId('L', 'limit', 4);
    run(
      `INSERT INTO limits (id, user_id, room_scope, start_ts, end_ts, reason, created_by, created_at)
       VALUES (?, 'U03', 'R1', ?, ?, '依据已生效违规记录设置 2 小时预约限制（历史样例）', 'M1', ?)`,
      limitId,
      pastOccurred + 24 * 60 * MINUTE,
      pastOccurred + 26 * 60 * MINUTE,
      pastOccurred + 3 * 60 * MINUTE,
    );
    run('INSERT INTO limit_basis (limit_id, violation_id) VALUES (?, ?)', limitId, vId);

    if (perf) seedPerf(ts, today);

    metaSet('seed_version', perf ? '1-perf' : '1');
  });
  return { seeded: true };
}

function seedIfEmpty() {
  if (get('SELECT COUNT(*) AS n FROM users').n === 0) {
    const result = seed();
    if (result.seeded) console.log('已写入演示数据：R1/R2 自习室、学生 U01—U03、场地管理员 M1/M2、系统管理员 S1');
  }
}

export { seed, seedIfEmpty, ensureDemoOpenPlans };

const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/server/seed.js');
if (isDirectRun) {
  const reset = process.argv.includes('--reset');
  const perf = process.argv.includes('--perf');
  const result = seed({ reset, perf });
  console.log(result.seeded ? '演示数据已生成。' : `未生成：${result.reason}`);
}
