/**
 * 场地布局与到座路线。
 * 布局由部署前核对的二维坐标构成：座位不可作为通路，路线只沿开放通道行走，
 * 从桌排外侧进入座位，不穿越其他座位、桌椅或墙体（BR-25）。
 */

const VIEW_W = 800;
const VIEW_H = 660;
const PX_PER_METER = 25;

/** 生成合成自习室布局（同一坐标体系供预约页和导航页共用） */
function buildLayout(seatCodes, { nearWindowCodes = null } = {}) {
  const half = Math.ceil(seatCodes.length / 2);
  const topCodes = seatCodes.slice(0, half);
  const bottomCodes = seatCodes.slice(half);
  const spacing = 86;
  const startX = 400 - ((half - 1) * spacing) / 2;

  const seats = {};
  const desks = [];
  const topRowY = 180;
  const bottomRowY = 480;
  const topAccessY = 100;
  const bottomAccessY = 560;

  topCodes.forEach((code, index) => {
    const x = startX + index * spacing;
    seats[code] = {
      code,
      x,
      y: topRowY,
      side: 'top',
      access: [x, topAccessY],
      seatEdge: [x, topRowY - 35],
      nearWindow: nearWindowCodes ? nearWindowCodes.includes(code) : true,
    };
    desks.push({ x: x - 34, y: 214, width: 68, height: 24, codes: [code] });
  });
  bottomCodes.forEach((code, index) => {
    const x = startX + index * spacing;
    seats[code] = {
      code,
      x,
      y: bottomRowY,
      side: 'bottom',
      access: [x, bottomAccessY],
      seatEdge: [x, bottomRowY + 35],
      nearWindow: nearWindowCodes ? nearWindowCodes.includes(code) : false,
    };
    desks.push({ x: x - 34, y: 422, width: 68, height: 24, codes: [code] });
  });

  return {
    version: 1,
    viewBox: [0, 0, VIEW_W, VIEW_H],
    pxPerMeter: PX_PER_METER,
    walls: { x: 40, y: 40, width: 720, height: 580 },
    corridors: [
      { id: 'top', label: '北侧通道', width: 34, points: [[60, topAccessY], [740, topAccessY]] },
      { id: 'bottom', label: '南侧通道', width: 34, points: [[60, bottomAccessY], [740, bottomAccessY]] },
      { id: 'left', label: '西侧通道', width: 30, points: [[60, topAccessY], [60, bottomAccessY]] },
      { id: 'right', label: '东侧通道', width: 30, points: [[740, topAccessY], [740, bottomAccessY]] },
    ],
    entrances: [
      { id: 'W', label: '西入口', point: [60, 330], outside: [16, 330] },
      { id: 'E', label: '东入口', point: [740, 330], outside: [784, 330] },
    ],
    seats,
    desks,
    obstacles: [
      { x: 150, y: 300, width: 150, height: 96, label: '书架' },
      { x: 325, y: 300, width: 150, height: 96, label: '书架' },
      { x: 500, y: 300, width: 150, height: 96, label: '书架' },
    ],
    windows: [
      { x1: 100, y1: 40, x2: 700, y2: 40 },
      { x1: 40, y1: 70, x2: 40, y2: 130 },
    ],
    labels: [
      { text: '窗户', x: 400, y: 26 },
      { text: '服务台', x: 92, y: 72 },
      { text: '自习区', x: 400, y: 640 },
    ],
    deskArea: { x: 80, y: 140, width: 640, height: 360 },
  };
}

function roundKey(x, y) {
  return `${Math.round(x * 10)}:${Math.round(y * 10)}`;
}

function pointSegmentDistance(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { distance: Math.hypot(px - cx, py - cy), t };
}

/** 构建通道图：节点为通道端点、入口连接点和座位接入点；座位本身不进入图 */
function buildGraph(map) {
  const nodes = [];
  const index = new Map();
  const edges = [];
  const addNode = (x, y) => {
    const key = roundKey(x, y);
    if (index.has(key)) return index.get(key);
    const id = nodes.length;
    nodes.push({ x, y });
    index.set(key, id);
    edges.push([]);
    return id;
  };
  const addEdge = (a, b) => {
    const weight = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
    edges[a].push({ to: b, weight });
    edges[b].push({ to: a, weight });
  };

  const fixedPoints = [
    ...map.entrances.map((e) => ({ point: e.point, kind: 'entrance', id: e.id })),
    ...Object.values(map.seats).map((s) => ({ point: s.access, kind: 'seat', id: s.code })),
  ];

  for (const corridor of map.corridors) {
    for (let i = 0; i < corridor.points.length - 1; i += 1) {
      const a = corridor.points[i];
      const b = corridor.points[i + 1];
      const attached = fixedPoints.filter((fp) => pointSegmentDistance(fp.point, a, b).distance <= 1.5);
      const points = [
        { x: a[0], y: a[1], t: 0 },
        { x: b[0], y: b[1], t: 1 },
        ...attached.map((fp) => ({ x: fp.point[0], y: fp.point[1], t: pointSegmentDistance(fp.point, a, b).t })),
      ];
      points.sort((p, q) => p.t - q.t);
      for (let j = 0; j < points.length - 1; j += 1) {
        const from = addNode(points[j].x, points[j].y);
        const to = addNode(points[j + 1].x, points[j + 1].y);
        if (from !== to) addEdge(from, to);
      }
    }
  }

  // 入口外侧 → 入口内侧
  for (const entrance of map.entrances) {
    const outside = addNode(entrance.outside[0], entrance.outside[1]);
    const inside = addNode(entrance.point[0], entrance.point[1]);
    if (outside !== inside) addEdge(outside, inside);
  }

  // 座位接入点 → 座位前缘（进入座位，不穿过座位本身）
  for (const seat of Object.values(map.seats)) {
    const access = addNode(seat.access[0], seat.access[1]);
    const edge = addNode(seat.seatEdge[0], seat.seatEdge[1]);
    if (access !== edge) addEdge(access, edge);
  }

  return { nodes, edges, addNode };
}

function dijkstra(graph, startId) {
  const dist = new Array(graph.nodes.length).fill(Infinity);
  const prev = new Array(graph.nodes.length).fill(-1);
  const visited = new Array(graph.nodes.length).fill(false);
  dist[startId] = 0;
  for (let iter = 0; iter < graph.nodes.length; iter += 1) {
    let current = -1;
    let best = Infinity;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        current = i;
      }
    }
    if (current < 0) break;
    visited[current] = true;
    for (const edge of graph.edges[current]) {
      if (dist[current] + edge.weight < dist[edge.to]) {
        dist[edge.to] = dist[current] + edge.weight;
        prev[edge.to] = current;
      }
    }
  }
  return { dist, prev };
}

const DIRECTION_TEXT = (dx, dy) => {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? '向东' : '向西';
  return dy >= 0 ? '向南' : '向北';
};

/** 计算到座路线：入口 → 通道最短路径 → 座位前缘 */
function computeRoute(map, seatCode, entranceId = 'W') {
  const seat = map.seats?.[seatCode];
  if (!map || !seat) return null;
  const entrance = map.entrances.find((e) => e.id === entranceId) || map.entrances[0];
  if (!entrance) return null;
  const graph = buildGraph(map);
  const outsideId = graph.addNode(entrance.outside[0], entrance.outside[1]);
  const targetKey = roundKey(seat.seatEdge[0], seat.seatEdge[1]);
  const targetId = graph.nodes.findIndex((n) => roundKey(n.x, n.y) === targetKey);
  if (targetId < 0) return null;
  const { dist, prev } = dijkstra(graph, outsideId);
  if (!Number.isFinite(dist[targetId])) return null;
  const path = [];
  let cursor = targetId;
  while (cursor >= 0) {
    path.push([graph.nodes[cursor].x, graph.nodes[cursor].y]);
    if (cursor === outsideId) break;
    cursor = prev[cursor];
  }
  path.reverse();
  const distancePx = dist[targetId];
  const pxPerMeter = map.pxPerMeter || PX_PER_METER;

  // 合并共线点，生成可读的行走说明
  const steps = [`从${entrance.label}进入自习室`];
  const simplified = [path[0]];
  for (let i = 1; i < path.length - 1; i += 1) {
    const [prevX, prevY] = simplified[simplified.length - 1];
    const [x, y] = path[i];
    const [nextX, nextY] = path[i + 1];
    const dx1 = Math.sign(x - prevX);
    const dy1 = Math.sign(y - prevY);
    const dx2 = Math.sign(nextX - x);
    const dy2 = Math.sign(nextY - y);
    if (dx1 !== dx2 || dy1 !== dy2) simplified.push(path[i]);
  }
  simplified.push(path[path.length - 1]);
  for (let i = 1; i < simplified.length; i += 1) {
    const [x0, y0] = simplified[i - 1];
    const [x1, y1] = simplified[i];
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length < 8) continue;
    const meters = (length / pxPerMeter).toFixed(1);
    if (i === simplified.length - 1) {
      steps.push(`到达${seatCode} 座位侧面，核对桌面编号后入座（约 ${meters} 米）`);
    } else {
      steps.push(`沿通道${DIRECTION_TEXT(x1 - x0, y1 - y0)}步行约 ${meters} 米`);
    }
  }
  return {
    available: true,
    seatCode,
    entranceId: entrance.id,
    entranceLabel: entrance.label,
    path,
    distanceMeters: Math.round((distancePx / pxPerMeter) * 10) / 10,
    steps,
    mapVersion: map.version,
  };
}

export { buildLayout, computeRoute, buildGraph, VIEW_W, VIEW_H, PX_PER_METER };