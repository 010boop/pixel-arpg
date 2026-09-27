// =====================================================================
//  main.js — 브라우저 멀티플레이 클라이언트 (Socket.io)
//
//  index.html(게임)보다 먼저 읽힘. 게임 안의 online(js/systems/online.js)이 window.netReady 를 기다렸다가 씀
//   · 이 서버에서 열면 → 이 서버로 접속
//   · 게임만 다른 곳(Vercel 등)에 올렸으면 주소 뒤에 ?server=https://내서버.onrender.com
//  보내기: join(처음 한 번) · move(내 상태, 초당 약 8번) · action(공격 · 스킬 …) · world(건축 · 농사) · sync(호스트만)
//  받기  : welcome · playerJoined · playerMoved · playerAction · playerLeft · worldOp · worldSync · host
// =====================================================================
(function () {
  // 게임(정적 파일)만 Vercel · Netlify 같은 곳에 올리고 서버는 Render 에 둘 때: 여기에 서버 주소를 적으세요
  //   예) const GAME_SERVER = 'https://pixel-field.onrender.com';
  const GAME_SERVER = '';

  function loadScript(src) {
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.append(s); });
  }
  function serverUrl() {
    const q = new URLSearchParams(location.search).get('server');
    if (q && /^https?:\/\//.test(q)) return q.replace(/\/$/, '');
    if (GAME_SERVER) return GAME_SERVER.replace(/\/$/, '');
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return null;                                          // 파일로 연 게임 → 혼자 하기
  }

  /** online 이 쓰는 모양 (presence · onPeers · onConnection) + 행동 · 월드 이벤트 */
  class SocketRoom {
    constructor(url) {
      this.id = null; this.hostId = null; this.peers = new Map(); this.ok = false; this.joined = false;
      this.cb = { conn: [], dead: [], peers: [] }; this.handlers = {};
      const sock = this.sock = io(url, { transports: ['websocket', 'polling'], reconnectionDelayMax: 8000 });
      sock.on('connect', () => { this.ok = true; this.joined = false; this.cb.conn.forEach((f) => f(true)); });
      sock.on('disconnect', () => { this.ok = false; this.peers.clear(); this.emitPeers(); this.cb.conn.forEach((f) => f(false)); this.fire('offline'); });
      sock.on('connect_error', () => { if (!this.everOk && ++this.fails >= 3) { sock.close(); this.cb.dead.forEach((f) => f()); } });
      this.fails = 0;
      sock.on('full', (n) => this.fire('full', n));
      sock.on('welcome', (w) => {
        this.everOk = true; this.id = w.id; this.hostId = w.host; this.guest = w.guest;
        this.peers.clear(); for (const [id, d] of Object.entries(w.players || {})) this.peers.set(id, d);
        this.emitPeers(); this.fire('welcome', w);
        if (this.mine) this.presence(this.mine);
      });
      sock.on('playerJoined', ({ id, d }) => { this.peers.set(id, d); this.emitPeers(); });
      sock.on('playerMoved', ({ id, d }) => { this.peers.set(id, d); this.emitPeers(); });
      sock.on('playerLeft', ({ id }) => { if (this.peers.delete(id)) this.emitPeers(); });
      sock.on('playerAction', (m) => this.fire('action', m));
      sock.on('worldOp', (m) => this.fire('worldOp', m));
      sock.on('worldSync', (m) => this.fire('worldSync', m));
      sock.on('host', (h) => { this.hostId = h; this.fire('host', h); });
      sock.on('rates', (r) => this.fire('rates', r));
      for (const ev of ['party', 'partyInvite', 'partyMsg', 'partyAct', 'season', 'notice', 'trade', 'tradeReq', 'tradeMsg', 'tradeDone', 'worldRestored']) sock.on(ev, (m) => this.fire(ev, m));   // 파티 · 시즌 · 공지
      sock.on('kicked', (m) => { sock.io.opts.reconnection = false; this.fire('kicked', m); });       // 관리자가 내보냄 → 다시 연결 안 함                  // 서버 배율 (관리자가 바꾸면 모두에게)
    }
    get isHost() { return this.ok && this.id && this.id === this.hostId; }
    fire(type, data) { (this.handlers[type] || []).forEach((f) => f(data)); }
    on(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); }
    emitPeers() { const peers = [...this.peers].map(([peer, presence]) => ({ peer, isMe: false, sameTab: false, presence })); this.cb.peers.forEach((f) => f({ peers })); }
    // ---- online 이 부르는 것
    presence(d) {
      this.mine = d;
      if (this.ok && this.id) {
        if (!this.joined && d && d.map !== undefined) { this.joined = true; this.sock.emit('join', d); }
        else this.sock.volatile.emit('move', d);
      }
      return Promise.resolve();
    }
    action(d) { if (this.ok) this.sock.emit('action', d); }
    world(op) { if (this.ok) this.sock.emit('world', op); }
    sync(d) { if (this.isHost) this.sock.emit('sync', d); }
    /** 파티: party:invite · accept · decline · leave · kick · act → cb({ ok, msg }) */
    partyEmit(ev, d, cb) { if (!this.ok) return cb && cb({ ok: false, msg: '서버에 연결돼 있지 않아요' }); if (!cb) { this.sock.emit(ev, d); return; } this.sock.timeout(5000).emit(ev, d, (err, res) => cb(err ? { ok: false, msg: '서버 응답이 없어요' } : res || { ok: true })); }
    /** 관리자 로그인 (서버가 ADMIN_PASSWORD 확인) → cb({ ok, msg }) */
    adminAuth(pass, cb) { if (!this.ok) return cb && cb({ ok: false, msg: '서버에 연결돼 있지 않아요' }); this.sock.timeout(6000).emit('adminAuth', { pass }, (err, res) => cb && cb(err ? { ok: false, msg: '서버 응답이 없어요' } : res)); }
    /** 관리자: 서버 배율 바꾸기 → cb({ ok, msg }) */
    setRates(pass, rates, cb) { if (!this.ok) return cb && cb({ ok: false, msg: '서버에 연결돼 있지 않아요' }); this.sock.timeout(6000).emit('setRates', { pass, rates }, (err, res) => cb && cb(err ? { ok: false, msg: '서버 응답이 없어요' } : res)); }
    onConnection(f, dead) { this.cb.conn.push(f); if (dead) this.cb.dead.push(dead); f(this.ok); return () => {}; }
    onPeers(f) { this.cb.peers.push(f); return () => {}; }
  }

  window.netReady = (async () => {
    const url = serverUrl(); if (!url) return null;
    if (!window.io) { try { await loadScript(url + '/socket.io/socket.io.js'); } catch (e) { return null; } }
    if (!window.io) return null;
    return new SocketRoom(url);
  })();
})();
