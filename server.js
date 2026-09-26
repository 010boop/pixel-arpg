// =====================================================================
//  server.js — Pixel Field 온라인 게임 서버 (Express + Socket.io)
//
//  실행:   npm install   (처음 한 번)
//          npm start     → http://localhost:3000
//  Render 같은 호스팅은 PORT 를 알아서 넣어 줌
//
//  구조
//   public/index.html  게임 (HTML5 Canvas · 그리기 · 전투 · 농사 · 건축 …)
//   public/main.js     브라우저 멀티플레이 클라이언트 (Socket.io 연결 · 이벤트 주고받기)
//   server.js          이 파일 — 접속자 관리 + 방송(Broadcast) + 공용 월드(영지 · 밭) 저장
//
//  이벤트 (클라이언트 → 서버 → 다른 모든 클라이언트)
//   connect     접속 → 무작위 ID · 손님 닉네임 부여 → 'welcome' (나 · 다른 플레이어 · 공용 월드)
//   join        내 캐릭터 정보 (이름 · 직업 · 장비 …) → 다른 사람들에게 'playerJoined'
//   move        위치 · 방향 · 동작 · 프레임 (초당 약 8번)        → 'playerMoved'
//   action      공격 · 스킬 · 채집 · 농사 · 건축 같은 한 번짜리 행동 → 'playerAction'
//   world       건축 · 농사로 바뀐 월드 (서버가 저장)             → 'worldOp'
//   sync        호스트(가장 먼저 온 사람)가 5초마다 보내는 밭 · 시계 → 'worldSync'
//   setRates    관리자 비밀번호 + 서버 배율(경험치 · 골드 · 드롭 …) → 저장하고 모두에게 'rates' (접속한 모든 사람에게 적용)
//   disconnect  나감                                               → 'playerLeft'
//  몬스터 · 전리품 · 가방 · 세이브는 각자 브라우저에 있음
// =====================================================================
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 60;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'world.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';           // ◀ 서버 배율을 바꿀 때 쓰는 관리자 비밀번호 (Render 환경 변수 ADMIN_PASSWORD 로 바꾸세요)
const RATE_KEYS = ['xp', 'gold', 'drop', 'gather', 'enh', 'elite', 'respawn'];
/** 서버 배율 검사: 알려진 키 · 0.1 ~ 100 */
function cleanRates(r) {
  const o = {}; if (!r || typeof r !== 'object') return null;
  for (const k of RATE_KEYS) { const v = Number(r[k]); o[k] = isFinite(v) && v >= 0.1 && v <= 100 ? Math.round(v * 10) / 10 : 1; }
  return o;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));
app.get('/status', (req, res) => res.json({ players: players.size, host: hostId, rates: world.rates }));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },                 // 게임을 다른 곳(Vercel 등)에 올려도 접속 가능
  maxHttpBufferSize: 256 * 1024,         // 밭 동기화(sync)가 가장 큼
  pingInterval: 20000, pingTimeout: 20000,
});

// ---------------------------------------------------------------- 공용 월드 (영지 집 · 가구 · 제작대 · 밭 · 시계)
let world = { tiles: {}, stations: {}, furn: [], rooms: {}, roof: 'wood', farm: {}, efarm: {}, clock: null, v: 1 };
let dirty = false;
let envRates = null; try { envRates = process.env.RATES ? cleanRates(JSON.parse(process.env.RATES)) : null; } catch (e) { /* 무시 */ }   // 예: RATES={"xp":2,"gold":2}
try { world = { ...world, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; console.log('공용 월드를 불러왔어요:', DATA); } catch (e) { console.log('새 공용 월드로 시작해요'); }
function saveWorld() {
  if (!dirty) return; dirty = false;
  try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA + '.tmp', JSON.stringify(world)); fs.renameSync(DATA + '.tmp', DATA); }
  catch (e) { console.warn('월드 저장 실패', e.message); }
}
if (!world.rates && envRates) world.rates = envRates;
world.rates = cleanRates(world.rates) || cleanRates({});
console.log('서버 배율:', JSON.stringify(world.rates));
setInterval(saveWorld, 20000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dirty = true; saveWorld(); process.exit(0); });

/** 클라이언트 housing.load 가 읽는 모양으로 */
function snapshot() {
  return {
    housing: { tiles: Object.entries(world.tiles).map(([k, id]) => [...k.split(',').map(Number), id]), furn: world.furn, rooms: world.rooms || {}, roof: world.roof, estate: 1,
      stations: Object.entries(world.stations), storages: {} },
    farm: Object.values(world.farm), efarm: Object.values(world.efarm), clock: world.clock,
  };
}

// 입력 검사 (다른 사람이 보낸 건 믿지 않음)
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const idOk = (s) => typeof s === 'string' && /^[a-z0-9_]{1,40}$/.test(s);
const key = (x, y) => x + ',' + y;
function plotOk(p) {
  return p && typeof p === 'object' && int(p.tx, 0, 400) && int(p.ty, 0, 400) && (p.crop === null || idOk(p.crop))
    && int(p.stage, 0, 20) && typeof p.wet === 'boolean' && typeof p.t === 'number' && isFinite(p.t);
}
const cleanPlot = (p) => ({ tx: p.tx, ty: p.ty, crop: p.crop, stage: p.stage, wet: p.wet, t: Math.round(p.t * 10) / 10, dry: int(p.dry, 0, 9) ? p.dry : 0, dead: !!p.dead });

const roomOk = (r) => (r === undefined || r === '' ? '' : typeof r === 'string' && /^\d{1,3},\d{1,3}$/.test(r) ? r : null);
function roomList(room) { if (!room) return world.furn; world.rooms = world.rooms || {}; if (Object.keys(world.rooms).length > 200 && !world.rooms[room]) return []; return (world.rooms[room] = world.rooms[room] || []); }
/** 월드 변경 적용 → 성공하면 방송할 op (못 알아보면 null) */
function applyOp(op) {
  if (!op || typeof op !== 'object') return null;
  switch (op.op) {
    case 'place': {                                   // 영지 바깥 한 칸 (벽 · 창문 · 문 · 울타리 · 제작대 · 상자 …)
      if (!int(op.tx, 0, 400) || !int(op.ty, 0, 400) || !idOk(op.id)) return null;
      world.tiles[key(op.tx, op.ty)] = op.id; if (op.station) world.stations['o:' + key(op.tx, op.ty)] = 1;
      return { op: 'place', tx: op.tx, ty: op.ty, id: op.id, station: !!op.station };
    }
    case 'tiles': {                                   // 설계도: 여러 칸 한꺼번에
      if (!Array.isArray(op.set) || op.set.length > 400) return null;
      const set = op.set.filter((t) => Array.isArray(t) && int(t[0], 0, 400) && int(t[1], 0, 400) && idOk(t[2]));
      for (const [x, y, id] of set) world.tiles[key(x, y)] = id;
      return { op: 'tiles', set };
    }
    case 'remove': {
      if (!int(op.tx, 0, 400) || !int(op.ty, 0, 400)) return null;
      delete world.tiles[key(op.tx, op.ty)]; delete world.stations['o:' + key(op.tx, op.ty)];
      return { op: 'remove', tx: op.tx, ty: op.ty };
    }
    case 'upgrade': {                                 // 제작대 단계
      if (typeof op.key !== 'string' || !(op.key in world.stations) || !int(op.lv, 1, 3)) return null;
      world.stations[op.key] = op.lv; return { op: 'upgrade', key: op.key, lv: op.lv };
    }
    case 'roof': { if (!idOk(op.style)) return null; world.roof = op.style; return { op: 'roof', style: op.style }; }
    case 'placeIn': {                                 // 집 안 가구 (room = 집 문 칸 'x,y' · '' = 예전 방)
      const room = roomOk(op.room); if (room === null || !idOk(op.id) || !int(op.tx, 0, 60) || !int(op.ty, 0, 60)) return null;
      const L = roomList(room); if (L.length > 600) return null;
      L.push([op.id, op.tx, op.ty]); return { op: 'placeIn', id: op.id, tx: op.tx, ty: op.ty, room };
    }
    case 'removeIn': {
      const room = roomOk(op.room); if (room === null) return null;
      const L = roomList(room), i = L.findIndex((f) => f[1] === op.tx && f[2] === op.ty); if (i < 0) return null;
      L.splice(i, 1); return { op: 'removeIn', tx: op.tx, ty: op.ty, room };
    }
    case 'plot': {                                    // 밭 한 칸 (갈기 · 심기 · 물 · 수확 · 치우기)
      const f = op.farm === 'estate' ? world.efarm : op.farm === 'town' ? world.farm : null;
      if (!f || !plotOk(op.plot)) return null;
      const p = cleanPlot(op.plot); f[key(p.tx, p.ty)] = p; return { op: 'plot', farm: op.farm, plot: p };
    }
  }
  return null;
}

// ---------------------------------------------------------------- 접속자
const players = new Map();            // id → { name, state, joinedAt }
let hostId = null, guestNo = 1;
function pickHost() {
  const first = [...players.entries()].filter(([, p]) => p.state).sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
  const next = first ? first[0] : null;
  if (next !== hostId) { hostId = next; io.emit('host', hostId); }
}
/** 받은 상태를 4KB 이하 · 평범한 객체만 */
function stateOk(d) { if (!d || typeof d !== 'object' || Array.isArray(d)) return false; try { return JSON.stringify(d).length <= 4096; } catch (e) { return false; } }
/** 1초에 n번까지만 */
function limiter(n) { let t = Date.now(), c = 0; return () => { const now = Date.now(); if (now - t > 1000) { t = now; c = 0; } return ++c <= n; }; }

io.on('connection', (sock) => {
  if (players.size >= MAX_PLAYERS) { sock.emit('full', MAX_PLAYERS); sock.disconnect(true); return; }
  const id = sock.id, guest = '모험가' + String(guestNo++).padStart(3, '0');
  players.set(id, { name: guest, state: null, joinedAt: Date.now() });
  const others = {}; for (const [k, p] of players) if (k !== id && p.state) others[k] = p.state;
  sock.emit('welcome', { id, guest, host: hostId, players: others, world: snapshot(), rates: world.rates });
  log(`접속 ${guest} ${id} (현재 ${players.size}명)`);

  const okMove = limiter(30), okAct = limiter(20), okWorld = limiter(30);
  sock.on('join', (d) => {
    if (!stateOk(d)) return; const p = players.get(id); if (!p) return;
    p.state = d; if (typeof d.name === 'string' && d.name.trim()) p.name = d.name.slice(0, 16);
    sock.broadcast.emit('playerJoined', { id, d });
    pickHost();
  });
  sock.on('move', (d) => {
    if (!okMove() || !stateOk(d)) return; const p = players.get(id); if (!p) return;
    p.state = d; sock.broadcast.volatile.emit('playerMoved', { id, d });
    if (!hostId) pickHost();
  });
  sock.on('action', (d) => { if (okAct() && stateOk(d)) sock.broadcast.emit('playerAction', { id, d }); });
  sock.on('world', (op) => {
    if (!okWorld()) return;
    const clean = applyOp(op); if (!clean) return;
    dirty = true; sock.broadcast.emit('worldOp', { id, op: clean });
  });
  sock.on('sync', (d) => {                             // 호스트만: 밭 성장 · 시계를 모두에게 맞춤
    if (id !== hostId || !d || typeof d !== 'object') return;
    if (Array.isArray(d.farm) && d.farm.length <= 3000) world.farm = Object.fromEntries(d.farm.filter(plotOk).map(cleanPlot).map((p) => [key(p.tx, p.ty), p]));
    if (Array.isArray(d.efarm) && d.efarm.length <= 6000) world.efarm = Object.fromEntries(d.efarm.filter(plotOk).map(cleanPlot).map((p) => [key(p.tx, p.ty), p]));
    if (d.clock && int(d.clock.day, 1, 1e6) && typeof d.clock.t === 'number') world.clock = { day: d.clock.day, t: Math.round(d.clock.t) };
    dirty = true;
    sock.broadcast.emit('worldSync', { farm: Object.values(world.farm), efarm: Object.values(world.efarm), clock: world.clock });
  });
  const okRate = limiter(2);
  sock.on('setRates', (d, ack) => {                    // 관리자: 서버 배율 → 모두에게
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!okRate() || !d || typeof d !== 'object') return reply({ ok: false, msg: '잠시 뒤 다시 해 주세요' });
    if (d.pass !== ADMIN_PASSWORD) { log(`배율 변경 거부 (비밀번호 틀림) ${id}`); return reply({ ok: false, msg: '서버 관리자 비밀번호가 틀렸어요' }); }
    const r = cleanRates(d.rates); if (!r) return reply({ ok: false, msg: '배율 값이 이상해요' });
    world.rates = r; dirty = true; io.emit('rates', r);
    log(`서버 배율 변경 ${JSON.stringify(r)} by ${players.get(id) ? players.get(id).name : id}`);
    reply({ ok: true });
  });
  sock.on('disconnect', () => {
    const p = players.get(id); players.delete(id);
    io.emit('playerLeft', { id });
    log(`나감 ${p ? p.name : id} (현재 ${players.size}명)`);
    if (id === hostId) pickHost();
  });
});

function log(s) { console.log(new Date().toLocaleTimeString(), s); }
server.listen(PORT, () => {
  console.log('==========================================================');
  console.log(` Pixel Field 온라인 서버 → http://localhost:${PORT}`);
  for (const list of Object.values(require('os').networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(` 같은 와이파이 친구 → http://${n.address}:${PORT}`);
  console.log(' 끄려면 Ctrl + C');
  console.log('==========================================================');
});
