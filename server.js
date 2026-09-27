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
//   party:*     파티 (초대 · 수락 · 거절 · 나가기 · 추방 · 파티원끼리 행동: 경험치 공유 · 치유 · 버프 · 파티 채팅) — 최대 5명
//   관리자 페이지  https://내주소/admin  (admin.html · 비밀번호 = ADMIN_PASSWORD)
//               접속자 목록 · 서버 배율 · 시즌 초기화(모든 캐릭터 삭제) · 공지 · 강퇴  → /api/admin/* (헤더 x-admin-pass)
//   trade:*     1:1 거래 (신청 · 수락 · 올리기 · 확정 · 교환 · 취소) — 둘 다 [확정] 뒤 둘 다 [교환] 을 눌러야 성사
//   adminAuth   관리자 창 열기 (주소에 ?admin · 서버 비밀번호 확인)
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
const SEASON = String(process.env.SEASON || '').slice(0, 20);          // ◀ 시즌 번호 — Render 환경 변수 SEASON 을 바꾸면(1 → 2 …) 접속하는 모든 사람의 캐릭터가 초기화됨
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';           // ◀ 서버 배율을 바꿀 때 쓰는 관리자 비밀번호 (Render 환경 변수 ADMIN_PASSWORD 로 바꾸세요)
const RATE_KEYS = ['xp', 'gold', 'drop', 'gather', 'enh', 'elite', 'respawn'];
/** 서버 배율 검사: 알려진 키 · 0.1 ~ 100 */
/** 시즌 = 환경 변수 SEASON + 관리자 페이지에서 초기화한 시각(t) — 둘 중 하나라도 새로우면 접속자의 캐릭터가 지워짐 */
function seasonInfo() { return { env: SEASON, t: Number(world.seasonT) || 0 }; }
function cleanRates(r) {
  const o = {}; if (!r || typeof r !== 'object') return null;
  for (const k of RATE_KEYS) { const v = Number(r[k]); o[k] = isFinite(v) && v >= 0.1 && v <= 100 ? Math.round(v * 10) / 10 : 1; }
  return o;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));
app.get('/status', (req, res) => res.json({ players: players.size, parties: parties.size, trades: trades.size, host: hostId, rates: world.rates, season: seasonInfo() }));
const startedAt = Date.now();

// ---------------------------------------------------------------- 관리자 페이지 (/admin)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.use('/api/admin', express.json({ limit: '8kb' }));
const loginFails = new Map();                                   // IP → { n, t } (10분에 8번까지)
function adminOk(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(), f = loginFails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 8) { res.status(429).json({ ok: false, msg: '너무 많이 틀렸어요. 10분 뒤 다시 해 주세요' }); return false; }
  if (req.headers['x-admin-pass'] !== ADMIN_PASSWORD) { f.n++; loginFails.set(ip, f); log(`관리자 페이지 로그인 실패 ${ip} (${f.n}회)`); res.status(401).json({ ok: false, msg: '비밀번호가 틀렸어요' }); return false; }
  loginFails.delete(ip); return true;
}
app.get('/api/admin/state', (req, res) => {
  if (!adminOk(req, res)) return;
  const list = [...players.entries()].map(([id, p]) => {
    const s = p.state || {};
    return { id, name: p.name, cls: s.cls || null, lv: s.lv || null, map: s.map || null, hp: typeof s.hp === 'number' ? s.hp : null, party: p.party, host: id === hostId, since: p.joinedAt };
  });
  res.json({ ok: true, players: list, max: MAX_PLAYERS, parties: [...parties.keys()].map(partyInfo), rates: world.rates, season: seasonInfo(), uptime: Date.now() - startedAt,
    world: { tiles: Object.keys(world.tiles).length, furn: world.furn.length, farm: Object.keys(world.farm).length + Object.keys(world.efarm).length } });
});
app.post('/api/admin/rates', (req, res) => {
  if (!adminOk(req, res)) return;
  const r = cleanRates(req.body && req.body.rates); if (!r) return res.json({ ok: false, msg: '배율 값이 이상해요' });
  world.rates = r; dirty = true; io.emit('rates', r); log(`서버 배율 변경 (관리자 페이지) ${JSON.stringify(r)}`);
  res.json({ ok: true, rates: r });
});
app.post('/api/admin/notice', (req, res) => {
  if (!adminOk(req, res)) return;
  const text = String((req.body && req.body.text) || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  if (!text) return res.json({ ok: false, msg: '공지 내용을 적어 주세요' });
  io.emit('notice', { text }); log(`공지: ${text}`); res.json({ ok: true });
});
app.post('/api/admin/kick', (req, res) => {
  if (!adminOk(req, res)) return;
  const id = String((req.body && req.body.id) || ''), s = io.sockets.sockets.get(id);
  if (!s) return res.json({ ok: false, msg: '그 접속자가 없어요' });
  const name = (players.get(id) || {}).name || id;
  s.emit('kicked', { msg: String((req.body && req.body.msg) || '').slice(0, 80) }); setTimeout(() => s.disconnect(true), 300);
  log(`강퇴: ${name}`); res.json({ ok: true, msg: `${name}님을 내보냈어요` });
});
app.post('/api/admin/season', (req, res) => {                  // 시즌 초기화: 모든 캐릭터 삭제 + 공용 월드 처음으로
  if (!adminOk(req, res)) return;
  world = { tiles: {}, stations: {}, furn: [], rooms: {}, roof: 'wood', farm: {}, efarm: {}, clock: null, v: 1, rates: world.rates, seasonT: Date.now() };
  dirty = true; saveWorld();
  for (const pid of [...parties.keys()]) for (const m of parties.get(pid).members) { const q = players.get(m); if (q) q.party = null; }
  parties.clear();
  io.emit('season', seasonInfo()); log(`시즌 초기화 ${JSON.stringify(seasonInfo())}`);
  res.json({ ok: true, season: seasonInfo() });
});
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
console.log('서버 배율:', JSON.stringify(world.rates), '· 시즌:', SEASON || '(없음)', '· 관리자 페이지: /admin');
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

const roomOk = (r) => (r === undefined || r === '' ? '' : typeof r === 'string' && /^\d{1,3},\d{1,3}(#[2-6])?$/.test(r) ? r : null);   // '#2' = 2층 …
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
const players = new Map();            // id → { name, state, joinedAt, party, invites }

// ---------------------------------------------------------------- 파티 (서버 메모리 · 다시 켜면 없어짐)
const PARTY_MAX = 5;
const parties = new Map();            // 파티 id → { leader, members: Set }
let partyNo = 1;
// ---------------------------------------------------------------- 거래
const trades = new Map();              // tid → { a, b, offer: { [id]: { items, gold } }, lock: {}, ok: {} }
let tradeNo = 1;
function tradeView(T, me) {             // me 가 보는 거래 상태
  const them = T.a === me ? T.b : T.a, pm = players.get(me), pt = players.get(them);
  return { tid: T.tid, me: { name: pm ? pm.name : '?', ...T.offer[me], lock: !!T.lock[me], ok: !!T.ok[me] }, them: { id: them, name: pt ? pt.name : '?', ...T.offer[them], lock: !!T.lock[them], ok: !!T.ok[them] } };
}
function sendTrade(T) { for (const m of [T.a, T.b]) io.to(m).emit('trade', tradeView(T, m)); }
function endTrade(tid, msg) {
  const T = trades.get(tid); if (!T) return; trades.delete(tid);
  for (const m of [T.a, T.b]) { const q = players.get(m); if (q && q.trade === tid) q.trade = null; io.to(m).emit('trade', null); if (msg) io.to(m).emit('tradeMsg', msg); }
}
function cleanOffer(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.items) || d.items.length > 12) return null;
  const items = [];
  for (const it of d.items) {
    if (!it || typeof it.id !== 'string' || !/^[a-z0-9_]{1,48}(\+\d{1,2})?$/i.test(it.id) || !int(it.qty, 1, 9999)) return null;
    const same = items.find((x) => x.id === it.id); if (same) same.qty = Math.min(9999, same.qty + it.qty); else items.push({ id: it.id, qty: it.qty });
  }
  const gold = d.gold === undefined ? 0 : d.gold; if (!int(gold, 0, 1e9)) return null;
  return { items, gold };
}
function partyInfo(pid) {
  const P = parties.get(pid); if (!P) return null;
  return { id: pid, leader: P.leader, members: [...P.members].map((id) => ({ id, name: (players.get(id) || {}).name || '?' })) };
}
function sendParty(pid) { const info = partyInfo(pid); if (info) for (const m of parties.get(pid).members) io.to(m).emit('party', info); }
function partyMsg(pid, text, except) { const P = parties.get(pid); if (P) for (const m of P.members) if (m !== except) io.to(m).emit('partyMsg', text); }
function leaveParty(id, kicked) {
  const p = players.get(id), pid = p && p.party, P = pid && parties.get(pid); if (!P) return;
  P.members.delete(id); p.party = null; io.to(id).emit('party', null);
  if (kicked) io.to(id).emit('partyMsg', '파티에서 추방됐어요');
  if (P.members.size <= 1) {                                    // 혼자 남으면 해산
    for (const m of P.members) { const q = players.get(m); if (q) q.party = null; io.to(m).emit('party', null); io.to(m).emit('partyMsg', '파티가 해산됐어요'); }
    parties.delete(pid); return;
  }
  if (P.leader === id) P.leader = [...P.members][0];
  partyMsg(pid, `${p.name}님이 파티를 ${kicked ? '떠나게 됐어요 (추방)' : '떠났어요'}`);
  sendParty(pid);
}
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
  players.set(id, { name: guest, state: null, joinedAt: Date.now(), party: null, invites: new Map(), trade: null, treqs: new Map() });
  const others = {}; for (const [k, p] of players) if (k !== id && p.state) others[k] = p.state;
  sock.emit('welcome', { id, guest, host: hostId, players: others, world: snapshot(), rates: world.rates, season: seasonInfo() });
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
    p.state = d; if (typeof d.name === 'string' && d.name.trim() && p.name !== d.name.slice(0, 16)) { p.name = d.name.slice(0, 16); if (p.party) sendParty(p.party); }   // 캐릭터 이름 (파티 목록용)
    sock.broadcast.volatile.emit('playerMoved', { id, d });
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
  // ---- 파티
  const okParty = limiter(6), okPAct = limiter(15);
  const ackOf = (a) => (typeof a === 'function' ? a : () => {});
  sock.on('party:invite', (d, ack) => {
    const reply = ackOf(ack), me = players.get(id), to = d && typeof d.to === 'string' ? d.to : '', them = players.get(to);
    if (!okParty() || !me) return reply({ ok: false, msg: '잠시 뒤 다시 해 주세요' });
    if (!them || !them.state || to === id) return reply({ ok: false, msg: '그 사람을 찾을 수 없어요' });
    if (them.party && them.party === me.party) return reply({ ok: false, msg: '이미 같은 파티예요' });
    if (them.party) return reply({ ok: false, msg: `${them.name}님은 이미 다른 파티에 있어요` });
    const P = me.party && parties.get(me.party);
    if (P && P.leader !== id) return reply({ ok: false, msg: '파티장만 초대할 수 있어요' });
    if (P && P.members.size >= PARTY_MAX) return reply({ ok: false, msg: `파티는 최대 ${PARTY_MAX}명이에요` });
    them.invites.set(id, Date.now());
    io.to(to).emit('partyInvite', { from: id, name: me.name });
    reply({ ok: true, msg: `${them.name}님에게 파티 초대를 보냈어요` });
  });
  sock.on('party:accept', (d, ack) => {
    const reply = ackOf(ack), me = players.get(id), from = d && typeof d.from === 'string' ? d.from : '', inviter = players.get(from);
    if (!okParty() || !me) return reply({ ok: false });
    const t = me.invites.get(from); me.invites.delete(from);
    if (!t || Date.now() - t > 60000 || !inviter) return reply({ ok: false, msg: '초대가 만료됐어요' });
    if (me.party) return reply({ ok: false, msg: '먼저 지금 파티에서 나가 주세요' });
    let pid = inviter.party;
    if (!pid) { pid = 'p' + partyNo++; parties.set(pid, { leader: from, members: new Set([from]) }); inviter.party = pid; }
    const P = parties.get(pid);
    if (P.members.size >= PARTY_MAX) return reply({ ok: false, msg: '파티가 가득 찼어요' });
    P.members.add(id); me.party = pid;
    partyMsg(pid, `${me.name}님이 파티에 들어왔어요`, id);
    sendParty(pid); reply({ ok: true });
  });
  sock.on('party:decline', (d) => { const me = players.get(id), from = d && typeof d.from === 'string' ? d.from : ''; if (!me || !me.invites.delete(from)) return; io.to(from).emit('partyMsg', `${me.name}님이 파티 초대를 거절했어요`); });
  sock.on('party:leave', () => { if (okParty()) leaveParty(id); });
  sock.on('party:kick', (d) => {
    const me = players.get(id), P = me && me.party && parties.get(me.party), who = d && typeof d.id === 'string' ? d.id : '';
    if (!okParty() || !P || P.leader !== id || who === id || !P.members.has(who)) return;
    leaveParty(who, true);
  });
  sock.on('party:act', (d) => {                        // 파티원끼리만: 경험치 공유 · 치유 · 버프 · 파티 채팅
    const me = players.get(id), P = me && me.party && parties.get(me.party);
    if (!P || !okPAct() || !d || typeof d !== 'object') return;
    try { if (JSON.stringify(d).length > 600) return; } catch (e) { return; }
    for (const m of P.members) if (m !== id) io.to(m).emit('partyAct', { id, d });
  });

  // ---- 거래
  const okTrade = limiter(10);
  sock.on('trade:req', (d, ack) => {
    const reply = ackOf(ack), me = players.get(id), to = d && typeof d.to === 'string' ? d.to : '', them = players.get(to);
    if (!okTrade() || !me) return reply({ ok: false, msg: '잠시 뒤 다시 해 주세요' });
    if (!them || !them.state || to === id) return reply({ ok: false, msg: '그 사람을 찾을 수 없어요' });
    if (me.trade) return reply({ ok: false, msg: '이미 거래 중이에요' });
    if (them.trade) return reply({ ok: false, msg: `${them.name}님은 다른 사람과 거래 중이에요` });
    them.treqs.set(id, Date.now());
    io.to(to).emit('tradeReq', { from: id, name: me.name });
    reply({ ok: true, msg: `${them.name}님에게 거래를 신청했어요` });
  });
  sock.on('trade:accept', (d, ack) => {
    const reply = ackOf(ack), me = players.get(id), from = d && typeof d.from === 'string' ? d.from : '', them = players.get(from);
    if (!okTrade() || !me) return reply({ ok: false });
    const t = me.treqs.get(from); me.treqs.delete(from);
    if (!t || Date.now() - t > 30000 || !them) return reply({ ok: false, msg: '거래 신청이 만료됐어요' });
    if (me.trade || them.trade) return reply({ ok: false, msg: '둘 중 한 명이 이미 거래 중이에요' });
    const tid = 't' + tradeNo++, T = { tid, a: from, b: id, offer: { [from]: { items: [], gold: 0 }, [id]: { items: [], gold: 0 } }, lock: {}, ok: {} };
    trades.set(tid, T); me.trade = them.trade = tid;
    log(`거래 시작 ${them.name} ↔ ${me.name}`); sendTrade(T); reply({ ok: true });
  });
  sock.on('trade:decline', (d) => { const me = players.get(id), from = d && typeof d.from === 'string' ? d.from : ''; if (!me || !me.treqs.delete(from)) return; io.to(from).emit('tradeMsg', `${me.name}님이 거래를 거절했어요`); });
  const myTrade = () => { const me = players.get(id), T = me && me.trade && trades.get(me.trade); return T || null; };
  sock.on('trade:offer', (d) => {
    const T = myTrade(); if (!T || !okTrade()) return;
    if (T.lock[id]) return;                                    // 확정한 뒤엔 못 바꿈
    const o = cleanOffer(d); if (!o) return;
    T.offer[id] = o; T.lock = {}; T.ok = {};                   // 바뀌면 둘 다 다시 확정
    sendTrade(T);
  });
  sock.on('trade:lock', () => { const T = myTrade(); if (!T || !okTrade()) return; T.lock[id] = true; sendTrade(T); });
  sock.on('trade:confirm', () => {
    const T = myTrade(); if (!T || !okTrade()) return;
    if (!T.lock[T.a] || !T.lock[T.b]) return;                  // 둘 다 확정해야 교환 가능
    T.ok[id] = true;
    if (T.ok[T.a] && T.ok[T.b]) {                              // 성사: 각자에게 줄 것 · 받을 것
      for (const [m, o] of [[T.a, T.b], [T.b, T.a]]) io.to(m).emit('tradeDone', { give: T.offer[m], get: T.offer[o], with: (players.get(o) || {}).name || '?' });
      const pa = players.get(T.a), pb = players.get(T.b);
      log(`거래 성사 ${pa ? pa.name : T.a} ↔ ${pb ? pb.name : T.b} ${JSON.stringify(T.offer[T.a])} ↔ ${JSON.stringify(T.offer[T.b])}`);
      trades.delete(T.tid); if (pa) pa.trade = null; if (pb) pb.trade = null;
    } else sendTrade(T);
  });
  sock.on('trade:cancel', (d) => {
    const T = myTrade(); if (!T) return;
    const me = players.get(id), why = d && typeof d.why === 'string' ? d.why.slice(0, 60) : '';
    endTrade(T.tid, `${me ? me.name : '상대'}님이 거래를 취소했어요${why ? ` (${why})` : ''}`);
  });

  let authFails = 0;
  sock.on('adminAuth', (d, ack) => {                   // 관리자 창 열기 (서버 주인만 · 비밀번호는 서버만 앎)
    const reply = typeof ack === 'function' ? ack : () => {};
    if (authFails >= 5) return reply({ ok: false, msg: '너무 많이 틀렸어요. 새로고침 후 다시 해 주세요' });
    if (!d || d.pass !== ADMIN_PASSWORD) { authFails++; log(`관리자 로그인 실패 ${id} (${authFails}회)`); return reply({ ok: false, msg: '비밀번호가 틀렸어요' }); }
    log(`관리자 로그인 ${players.get(id) ? players.get(id).name : id}`); reply({ ok: true });
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
    leaveParty(id);
    const tp = players.get(id); if (tp && tp.trade) endTrade(tp.trade, '상대가 나가서 거래가 취소됐어요');
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
