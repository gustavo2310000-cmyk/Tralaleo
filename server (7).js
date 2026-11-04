'use strict';
// ENGINE: servidor autoritativo (movimento, combate, vida, visibilidade) + cliente embutido (PAGE).
// BIBLIOTECA: BASE (modelos padrão) + modelos criados pelo mestre na sala (room.lib).
// CAMPANHA: mapa + objetos da sala, exportáveis/importáveis em JSON.
const http = require('http'), crypto = require('crypto'), { Server } = require('socket.io');
const PORT = process.env.PORT || 3000, TS = 32, W = 40, H = 28, SOLID = [2, 3];
const KINDS = ['npc', 'enemy', 'prop', 'clue', 'trigger', 'spawn'];

const BASE = [
  { id: 'zumbi', kind: 'enemy', name: 'Zumbi', emoji: '🧟', color: '#7a9a5a', hp: 20, atk: 4, spd: 55 },
  { id: 'cultista', kind: 'enemy', name: 'Cultista', emoji: '🧙', color: '#aa3333', hp: 14, atk: 5, spd: 80 },
  { id: 'criatura', kind: 'enemy', name: 'Criatura do Outro Lado', emoji: '👹', color: '#880088', hp: 45, atk: 9, spd: 70 },
  { id: 'npc', kind: 'npc', name: 'Sobrevivente', emoji: '🧑', color: '#ffcc66', dialog: ['Você viu aquilo? Não saia sozinho.'] },
  { id: 'caixa', kind: 'prop', name: 'Caixote', emoji: '📦', color: '#aa7733', solid: true },
  { id: 'pista', kind: 'clue', name: 'Pista', emoji: '🔍', color: '#66ccff', text: 'Descreva a pista aqui.', hidden: true },
  { id: 'gatilho', kind: 'trigger', name: 'Encontro', emoji: '⚡', color: '#ffff66', msg: 'Algo se move nas sombras...', spawn: 'zumbi', count: 2, r: 64 },
  { id: 'inicio', kind: 'spawn', name: 'Início', emoji: '🚩', color: '#ffffff' }
];

const rooms = new Map();
const rnd = n => Math.random() * n, uid = () => crypto.randomBytes(8).toString('hex');
const cl = (v, a, b) => Math.min(b, Math.max(a, +v || 0));
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const mkMap = () => {
  const t = new Array(W * H).fill(0);
  for (let i = 0; i < W; i++) { t[i] = 2; t[(H - 1) * W + i] = 2; }
  for (let j = 0; j < H; j++) { t[j * W] = 2; t[j * W + W - 1] = 2; }
  return t;
};
const libOf = r => BASE.concat(r.lib);

// Normaliza/valida um objeto vindo do mestre (cria ou atualiza `old`).
function clean(o, old) {
  o = o || {};
  const k = KINDS.includes(o.kind) ? o.kind : old && old.kind;
  if (!k) return null;
  const r = old || { id: null, kind: k };
  r.x = cl(o.x != null ? o.x : r.x, 0, W * TS); r.y = cl(o.y != null ? o.y : r.y, 0, H * TS);
  r.name = str(o.name != null ? o.name : r.name, 40);
  r.emoji = str(o.emoji != null ? o.emoji : r.emoji, 4);
  r.color = /^#[0-9a-f]{3,6}$/i.test(o.color) ? o.color : r.color || '#cccccc';
  r.note = str(o.note != null ? o.note : r.note, 500);
  r.text = str(o.text != null ? o.text : r.text, 1500);
  r.hidden = k === 'trigger' || k === 'spawn' ? true : !!(o.hidden != null ? o.hidden : r.hidden);
  r.solid = !!(o.solid != null ? o.solid : r.solid);
  r.dialog = (Array.isArray(o.dialog) ? o.dialog : r.dialog || []).slice(0, 30).map(s => str(s, 300)).filter(Boolean);
  if (k === 'enemy') {
    const hp = cl(o.hp != null ? o.hp : r.maxhp != null ? r.maxhp : 20, 1, 9999);
    if (!r.maxhp || o.hp != null) { r.maxhp = hp; r.hp = hp; }
    r.atk = cl(o.atk != null ? o.atk : r.atk != null ? r.atk : 4, 0, 999);
    r.spd = cl(o.spd != null ? o.spd : r.spd != null ? r.spd : 60, 0, 200);
  }
  if (k === 'trigger') {
    r.msg = str(o.msg != null ? o.msg : r.msg, 200); r.spawn = str(o.spawn != null ? o.spawn : r.spawn, 30);
    r.count = cl(o.count != null ? o.count : r.count != null ? r.count : 1, 0, 10);
    r.r = cl(o.r != null ? o.r : r.r || 64, 16, 300);
    if (o.reset) r.done = false;
  }
  return r;
}
const addObj = (r, d) => {
  if (r.objs.length >= 300) return null;
  const n = clean(d); if (!n) return null;
  n.id = 'o' + r.seq++; r.objs.push(n); return n;
};
// O que o jogador pode ver: nada de ocultos, gatilhos, notas ou textos secretos.
const pubObj = o => o.kind === 'trigger' || o.kind === 'spawn' || o.hidden ? null :
  { id: o.id, kind: o.kind, x: Math.round(o.x), y: Math.round(o.y), name: o.name, emoji: o.emoji, color: o.color, solid: o.solid, hp: o.hp, maxhp: o.maxhp };

const blocked = (r, x, y) => {
  const c = Math.floor(x / TS), d = Math.floor(y / TS);
  if (c < 0 || d < 0 || c >= W || d >= H || SOLID.includes(r.tiles[d * W + c])) return true;
  return r.objs.some(o => o.solid && Math.abs(o.x - x) < 16 && Math.abs(o.y - y) < 16);
};
const move = (r, e, dx, dy) => { if (!blocked(r, e.x + dx, e.y)) e.x += dx; if (!blocked(r, e.x, e.y + dy)) e.y += dy; };
const toAll = (r, ev, d) => {
  if (r.msid) io.to(r.msid).emit(ev, d);
  if (r.playing) for (const p of Object.values(r.players)) if (p.sid) io.to(p.sid).emit(ev, d);
};
const toast = (r, t) => io.to(r.code).emit('toast', t);
const fxe = (r, f) => io.to(r.code).emit('fx', f);
const roster = r => io.to(r.code).emit('roster', { names: Object.values(r.players).map(p => p.name + (p.sid ? '' : ' (off)')), playing: r.playing });

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
function derive(p) { p.maxhp = 12 + p.at.VIG * 4; p.atk = 2 + p.at.FOR * 2; p.spd = 90 + p.at.AGI * 14; p.def = Math.floor(p.at.VIG / 2); }
function newP(pid, sid, name, n) {
  const p = { pid, sid, name, color: COLORS[n % COLORS.length], at: { FOR: 2, AGI: 2, INT: 1, PRE: 1, VIG: 2 }, x: 0, y: 0, ix: 0, iy: 0, dir: 0, cd: 0, dead: false, rt: 0, in: false };
  derive(p); p.hp = p.maxhp; return p;
}
function spawnP(r, p) {
  const s = r.objs.find(o => o.kind === 'spawn') || { x: W * TS / 2, y: H * TS / 2 };
  p.x = s.x + rnd(24) - 12; p.y = s.y + rnd(24) - 12; p.hp = p.maxhp; p.dead = false; p.in = true; p.ix = p.iy = 0;
}
function hurt(r, p, d) {
  p.hp -= d; fxe(r, { t: 'dmg', x: p.x, y: p.y, v: d, c: '#ff5555' });
  if (p.hp <= 0) { p.hp = 0; p.dead = true; p.rt = 8; toast(r, p.name + ' caiu!'); }
}
function fire(r, o) {
  o.done = true; if (o.msg) toast(r, o.msg);
  const t = libOf(r).find(l => l.id === o.spawn && l.kind === 'enemy');
  if (t) for (let i = 0; i < o.count; i++) { const e = Object.assign({}, t, { x: o.x + rnd(60) - 30, y: o.y + rnd(60) - 30 }); delete e.id; addObj(r, e); }
}

function step(r, dt) {
  if (!r.playing) return;
  const ps = Object.values(r.players).filter(p => p.in);
  for (const p of ps) {
    if (p.dead) { if ((p.rt -= dt) <= 0) spawnP(r, p); continue; }
    p.cd = Math.max(0, p.cd - dt);
    const l = Math.hypot(p.ix, p.iy);
    if (l > 0) { const dx = p.ix / l, dy = p.iy / l; move(r, p, dx * p.spd * dt, dy * p.spd * dt); p.dir = Math.atan2(dy, dx); }
  }
  for (const o of r.objs) {
    if (o.kind === 'enemy') {
      o.cd = Math.max(0, (o.cd || 0) - dt);
      let t = null, bd = 260;
      for (const p of ps) { if (p.dead) continue; const d = Math.hypot(p.x - o.x, p.y - o.y); if (d < bd) { bd = d; t = p; } }
      if (!t) continue;
      if (bd > 26) { const a = Math.atan2(t.y - o.y, t.x - o.x); move(r, o, Math.cos(a) * o.spd * dt, Math.sin(a) * o.spd * dt); }
      else if (o.cd <= 0) { o.cd = 1; hurt(r, t, Math.max(1, Math.round(o.atk * r.diff) - t.def)); }
    } else if (o.kind === 'trigger' && !o.done && ps.some(p => !p.dead && Math.hypot(p.x - o.x, p.y - o.y) < o.r)) fire(r, o);
  }
}
function send(r) {
  if (r.msid) io.to(r.msid).emit('tick', { ps: playersPub(r), os: r.objs });
  if (!r.playing) return;
  const pub = { ps: playersPub(r), os: r.objs.map(pubObj).filter(Boolean) };
  for (const p of Object.values(r.players)) if (p.sid) io.to(p.sid).emit('tick', pub);
}
const playersPub = r => Object.values(r.players).filter(p => p.in).map(p => ({ id: p.pid, name: p.name, x: Math.round(p.x), y: Math.round(p.y), hp: p.hp, maxhp: p.maxhp, dir: p.dir, dead: p.dead, color: p.color }));

const server = http.createServer((q, s) => {
  if (q.url === '/healthz') { s.end('ok'); return; }
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(PAGE());
});
const io = new Server(server, { maxHttpBufferSize: 1e6 });

setInterval(() => { for (const r of rooms.values()) { step(r, 0.05); send(r); } }, 50);
setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) {
    for (const [pid, p] of Object.entries(r.players)) if (!p.sid && now - (p.off || now) > 120000) { delete r.players[pid]; roster(r); }
    if (!r.msid && !Object.values(r.players).some(p => p.sid)) { r.idle = r.idle || now; if (now - r.idle > 600000) rooms.delete(c); } else r.idle = 0;
  }
}, 5000);

io.on('connection', s => {
  const C = () => { const r = rooms.get(s.data.code); return r ? { r, m: s.id === r.msid, p: r.players[s.data.pid] } : {}; };
  const enter = (r, pid) => { s.data = { code: r.code, pid }; s.join(r.code); r.idle = 0; };
  const initM = r => {
    s.emit('map', { tiles: r.tiles }); s.emit('lib', libOf(r)); s.emit('journal', r.journal); roster(r);
  };
  const initP = (r, p) => {
    p.off = 0; s.emit('me', { at: p.at }); s.emit('journal', r.journal);
    if (r.playing) { if (!p.in) spawnP(r, p); s.emit('map', { tiles: r.tiles }); }
    roster(r);
  };

  s.on('room:create', (d, cb) => {
    if (rooms.size > 60) return cb({ err: 'Servidor cheio' });
    let c; do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[rnd(23) | 0]).join(''); while (rooms.has(c));
    const r = { code: c, master: uid(), msid: s.id, players: {}, tiles: mkMap(), objs: [], lib: [], journal: [], playing: false, seq: 1, diff: 1, idle: 0 };
    rooms.set(c, r); enter(r, r.master);
    addObj(r, Object.assign({}, BASE.find(b => b.id === 'inicio'), { x: W * TS / 2, y: H * TS / 2 }));
    cb({ ok: 1, code: c, pid: r.master, role: 'm' }); initM(r);
  });
  s.on('room:join', (d, cb) => {
    const r = rooms.get(str(d && d.code, 4).toUpperCase());
    if (!r) return cb({ err: 'Sala não encontrada' });
    if (Object.keys(r.players).length >= 12) return cb({ err: 'Sala cheia' });
    const pid = uid(), p = newP(pid, s.id, str(d.name, 16).trim() || 'Agente', Object.keys(r.players).length);
    r.players[pid] = p; enter(r, pid); cb({ ok: 1, code: r.code, pid, role: 'p' }); initP(r, p);
  });
  s.on('room:rejoin', (d, cb) => {
    const r = rooms.get(d && d.code);
    if (!r) return cb({ err: 'Sala encerrada' });
    if (d.pid === r.master) { r.msid = s.id; enter(r, d.pid); cb({ ok: 1, code: r.code, pid: d.pid, role: 'm' }); return initM(r); }
    const p = r.players[d.pid];
    if (!p) return cb({ err: 'Sessão expirada' });
    p.sid = s.id; enter(r, d.pid); cb({ ok: 1, code: r.code, pid: d.pid, role: 'p' }); initP(r, p);
  });
  s.on('disconnect', () => {
    const { r, m, p } = C(); if (!r) return;
    if (m) r.msid = null; else if (p && p.sid === s.id) { p.sid = null; p.ix = p.iy = 0; p.off = Date.now(); roster(r); }
  });

  // ---- jogador ----
  s.on('attrs', d => {
    const { p } = C(); if (!p || p.in || !d) return;
    const n = {}; let sum = 0;
    for (const k of ['FOR', 'AGI', 'INT', 'PRE', 'VIG']) { n[k] = Math.round(cl(d[k], 0, 5)); sum += n[k]; }
    if (sum > 10) return;
    p.at = n; derive(p); p.hp = p.maxhp; s.emit('me', { at: n });
  });
  s.on('input', d => { const { p } = C(); if (p && p.in && d) { p.ix = cl(d.x, -1, 1); p.iy = cl(d.y, -1, 1); } });
  s.on('attack', d => {
    const { r, p } = C(); if (!p || !p.in || p.dead || p.cd > 0) return;
    p.cd = 0.5; if (d && Number.isFinite(d.a)) p.dir = d.a;
    const ax = p.x + Math.cos(p.dir) * 26, ay = p.y + Math.sin(p.dir) * 26;
    fxe(r, { t: 'slash', x: ax, y: ay, a: p.dir });
    for (const o of r.objs.slice()) {
      if (o.kind !== 'enemy' || Math.hypot(o.x - ax, o.y - ay) > 42) continue;
      const dmg = p.atk + (rnd(3) | 0); o.hp -= dmg;
      fxe(r, { t: 'dmg', x: o.x, y: o.y, v: dmg, c: '#ffd34d' });
      if (o.hp <= 0) r.objs = r.objs.filter(x => x !== o);
    }
  });
  s.on('interact', () => {
    const { r, p } = C(); if (!p || !p.in || p.dead) return;
    let b = null, bd = 48;
    for (const o of r.objs) { if (o.hidden || (o.kind !== 'npc' && o.kind !== 'clue')) continue; const d = Math.hypot(o.x - p.x, o.y - p.y); if (d < bd) { bd = d; b = o; } }
    if (!b) return;
    if (b.kind === 'npc') s.emit('dialog', { name: b.name, emoji: b.emoji, lines: b.dialog.length ? b.dialog : ['...'] });
    else {
      s.emit('dialog', { name: b.name, emoji: b.emoji, lines: [b.text || '(sem informação)'] });
      if (!r.journal.some(j => j.id === b.id)) { r.journal.push({ id: b.id, t: b.name, x: b.text }); io.to(r.code).emit('journal', r.journal); }
    }
  });

  // ---- mestre ----
  const M = fn => (d, cb) => { const c = C(); if (c.r && c.m) fn(c.r, d, cb); };
  s.on('map:paint', M((r, d) => {
    const x = Math.floor(+d.x), y = Math.floor(+d.y), t = Math.floor(cl(d.t, 0, 4));
    if (!(x >= 0 && y >= 0 && x < W && y < H)) return;
    r.tiles[y * W + x] = t; toAll(r, 'tiles', [[x, y, t]]);
  }));
  s.on('obj:put', M((r, d) => {
    if (!d || !d.obj) return;
    const old = d.obj.id && r.objs.find(o => o.id === d.obj.id);
    if (old) clean(d.obj, old); else addObj(r, d.obj);
  }));
  s.on('obj:del', M((r, id) => { r.objs = r.objs.filter(o => o.id !== id); }));
  s.on('game:start', M(r => {
    r.playing = true; r.objs.forEach(o => { if (o.kind === 'trigger') o.done = false; });
    Object.values(r.players).forEach(p => { spawnP(r, p); if (p.sid) io.to(p.sid).emit('map', { tiles: r.tiles }); });
    roster(r);
  }));
  s.on('game:stop', M(r => {
    r.playing = false; Object.values(r.players).forEach(p => { p.in = false; p.hp = p.maxhp; p.dead = false; });
    for (const p of Object.values(r.players)) if (p.sid) io.to(p.sid).emit('stop');
    roster(r);
  }));
  s.on('heal', M(r => { Object.values(r.players).forEach(p => { p.hp = p.maxhp; p.dead = false; }); toast(r, 'O grupo foi restaurado.'); }));
  s.on('say', M((r, t) => toast(r, str(t, 200))));
  s.on('diff', M((r, v) => { r.diff = cl(v, 0.5, 3); }));
  s.on('lib:save', M((r, d) => {
    if (r.lib.length >= 40 || !d || !d.obj) return;
    const n = clean(Object.assign({}, d.obj, { x: 0, y: 0 })); if (!n) return;
    delete n.done; n.id = 'c' + r.seq++; r.lib.push(n); s.emit('lib', libOf(r));
  }));
  s.on('camp:export', M((r, d, cb) => cb && cb(JSON.stringify({ v: 1, tiles: r.tiles, objs: r.objs, lib: r.lib }))));
  s.on('camp:import', M((r, d, cb) => {
    try {
      const j = JSON.parse(d);
      if (!Array.isArray(j.tiles) || j.tiles.length !== W * H) throw new Error('mapa inválido');
      r.tiles = j.tiles.map(t => Math.floor(cl(t, 0, 4))); r.objs = []; r.seq = 1;
      (j.objs || []).slice(0, 300).forEach(o => addObj(r, o));
      r.lib = []; (j.lib || []).slice(0, 40).forEach(o => { const n = clean(o); if (n) { n.id = 'c' + r.seq++; r.lib.push(n); } });
      r.journal = []; s.emit('map', { tiles: r.tiles }); s.emit('lib', libOf(r)); io.to(r.code).emit('journal', []);
      if (r.playing) Object.values(r.players).forEach(p => { if (p.sid) io.to(p.sid).emit('map', { tiles: r.tiles }); });
      cb && cb({ ok: 1 });
    } catch (e) { cb && cb({ err: 'Arquivo inválido' }); }
  }));
});

server.listen(PORT, '0.0.0.0', () => console.log('Engine Paranormal na porta ' + PORT));

// ================= CLIENTE (página única) =================
function PAGE() { return String.raw`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Engine Paranormal</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#08070c;color:#e6e1d8;font:14px/1.4 'Trebuchet MS',system-ui,sans-serif;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}
[hidden]{display:none!important}
input,select,textarea,button{font:inherit;color:inherit;background:#17141f;border:1px solid #3b3350;border-radius:4px;padding:8px;min-width:0}
textarea{width:100%;height:64px;user-select:text}input{user-select:text}
button{cursor:pointer;background:#241a30}button:active,button.on{background:#8a1c2c;border-color:#c8394d}
h1{font:italic 700 26px Georgia,serif;letter-spacing:.04em;margin:0;color:#d23a4c}
.screen{display:flex;flex-direction:column;gap:10px;max-width:340px;margin:10vh auto;padding:20px}
.screen small{color:#8d86a0}#err{color:#ff7b8a;min-height:1.2em}
#cv{position:fixed;inset:0;width:100%;height:100%}
#hud{position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;display:flex;gap:8px;padding:8px;pointer-events:none;align-items:center}
#hud>*{pointer-events:auto}#code{font:700 16px monospace;background:#17141f;padding:4px 8px;border-radius:4px;letter-spacing:.2em}
#hpb{width:120px;height:10px;background:#300;border-radius:5px;overflow:hidden}#hpf{height:100%;background:#d23a4c;width:100%}
#toast{position:fixed;top:56px;left:50%;transform:translateX(-50%);background:#000c;border:1px solid #8a1c2c;padding:8px 14px;border-radius:4px;max-width:80vw;text-align:center;opacity:0;transition:opacity .3s;pointer-events:none}
#wait{position:fixed;inset:0;background:#08070c;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;padding:20px;text-align:center}
#atb div{display:flex;gap:8px;align-items:center;justify-content:center;margin:3px}#atb b{width:36px;text-align:left}
#dlg,#jr{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(120px + env(safe-area-inset-bottom,0));width:min(92vw,520px);background:#0d0a12f2;border:1px solid #8a1c2c;border-radius:6px;padding:12px}
#dlg p{font:italic 16px Georgia,serif;margin:8px 0}#jr{bottom:auto;top:56px;max-height:60vh;overflow:auto}
#mp{position:fixed;right:0;top:0;bottom:0;width:300px;background:#0d0a12f5;border-left:1px solid #3b3350;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px;padding-top:48px}
#mp label{display:block;font-size:12px;color:#a69fba;margin-top:4px}#mp label input:not([type=checkbox]),#mp label select{width:100%}
#tools,#tiles,#ses{display:flex;flex-wrap:wrap;gap:6px}#tools button{flex:1;font-size:18px}
#tiles button{width:38px;height:38px;padding:0}
#mt{position:fixed;right:8px;top:calc(8px + env(safe-area-inset-top,0));z-index:5}
#touch{display:none}
@media(pointer:coarse){#touch:not([hidden]){display:block}}
#joy{position:fixed;left:24px;bottom:calc(24px + env(safe-area-inset-bottom,0));width:120px;height:120px;border-radius:50%;background:#ffffff14;border:1px solid #fff3;touch-action:none}
#knob{position:absolute;left:40px;top:40px;width:40px;height:40px;border-radius:50%;background:#d23a4ccc}
#bA,#bE{position:fixed;right:24px;width:68px;height:68px;border-radius:50%;font-size:26px;bottom:calc(24px + env(safe-area-inset-bottom,0))}#bE{right:104px;bottom:calc(44px + env(safe-area-inset-bottom,0));width:52px;height:52px}
@media(max-width:700px){#mp{top:auto;left:0;width:auto;max-height:46vh;border-left:0;border-top:1px solid #3b3350;padding-top:8px}#mp.c>*{display:none}}
</style></head><body>
<div id="home" class="screen"><h1>Engine Paranormal</h1><small>RPG de ação cooperativo com mestre e editor de campanha.</small>
<input id="nm" maxlength="16" placeholder="Seu nome"><button id="bc">Criar sala como mestre</button>
<small>ou entre numa sala existente</small><input id="cd" maxlength="4" placeholder="Código da sala" style="text-transform:uppercase"><button id="bj">Entrar na sala</button><div id="err"></div></div>
<div id="game" hidden><canvas id="cv"></canvas>
<div id="hud"><span id="code"></span><div id="hpb"><div id="hpf"></div></div><button id="bjr">📖</button></div>
<div id="toast"></div>
<div id="wait"><h1>Aguardando o mestre</h1><div>Sala <b id="code2"></b></div><div id="ros"></div><small>Distribua 10 pontos de atributo antes de começar:</small><div id="atb"></div><small id="der"></small></div>
<div id="dlg" hidden></div><div id="jr" hidden></div>
<div id="touch" hidden><div id="joy"><i id="knob"></i></div><button id="bE">💬</button><button id="bA">⚔️</button></div>
<button id="mt" hidden>☰</button>
<div id="mp" hidden>
<div id="tools"><button data-t="hand" title="Mover câmera">🖐</button><button data-t="sel" title="Selecionar/editar">✏️</button><button data-t="paint" title="Terreno">🎨</button><button data-t="place" title="Colocar">➕</button><button data-t="del" title="Apagar">🗑</button></div>
<div id="tiles" hidden></div><div id="libw" hidden><select id="lib" style="width:100%"></select></div>
<div id="insp"></div>
<div id="ses"><button id="go" style="flex:1">▶ Iniciar sessão</button><button id="heal">✚ Curar</button></div>
<label>Dificuldade dos inimigos <input id="diff" type="range" min="0.5" max="3" step="0.25" value="1" style="width:100%"></label>
<div style="display:flex;gap:6px"><input id="say" placeholder="Mensagem para todos" style="flex:1"><button id="bsay">📣</button></div>
<div style="display:flex;gap:6px"><button id="exp" style="flex:1">💾 Exportar</button><button id="imp" style="flex:1">📂 Importar</button></div><input id="file" type="file" hidden>
<small id="ros2"></small></div></div>
<script src="/socket.io/socket.io.js"></script><script>
const $=i=>document.getElementById(i),TS=32,W=40,H=28;
const COL=['#2f4a2c','#6b5a47','#2a2a33','#1d3b5c','#5a1a1a'],TN=['Grama','Piso','Parede','Água','Ritual'],AT=['FOR','AGI','INT','PRE','VIG'];
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const sock=io();
let me={},map=null,ps=[],os=[],fx=[],lib=[],tool='hand',tile=2,sel=null,jr=[],at={},cam={x:640,y:448},down=new Set(),jx=0,jy=0,last='',dl=null,Z=1,disp={},ro={names:[],playing:false},lc=-1,drag=null;
$('nm').value=localStorage.pn||'';
sock.on('connect',()=>{const s=sessionStorage.po;if(s)sock.emit('room:rejoin',JSON.parse(s),ready)});
function ready(r){
 if(r.err){sessionStorage.removeItem('po');$('err').textContent=r.err;$('home').hidden=false;$('game').hidden=true;me={};return}
 me=r;sessionStorage.po=JSON.stringify({code:r.code,pid:r.pid});
 $('home').hidden=true;$('game').hidden=false;$('code').textContent=$('code2').textContent=r.code;
 const m=r.role==='m';$('mp').hidden=!m;$('mt').hidden=!m;$('wait').hidden=m||!!map;layout();if(m){setTool('hand');insp()}
}
function layout(){$('touch').hidden=!(map&&me.role==='p');$('wait').hidden=me.role==='m'||!!map;$('hpb').hidden=me.role!=='p'}
$('bc').onclick=()=>{localStorage.pn=$('nm').value;sock.emit('room:create',{},ready)};
$('bj').onclick=()=>{localStorage.pn=$('nm').value;sock.emit('room:join',{code:$('cd').value,name:$('nm').value},ready)};
$('mt').onclick=()=>$('mp').classList.toggle('c');
$('bjr').onclick=()=>{$('jr').hidden=!$('jr').hidden};
sock.on('map',m=>{map=m;layout()});
sock.on('tiles',a=>{if(map)a.forEach(t=>map.tiles[t[1]*W+t[0]]=t[2])});
sock.on('tick',d=>{ps=d.ps;os=d.os;const m=ps.find(p=>p.id===me.pid);if(m){$('hpf').style.width=100*m.hp/m.maxhp+'%'}});
sock.on('stop',()=>{map=null;os=[];ps=[];dl=null;$('dlg').hidden=true;layout()});
sock.on('lib',l=>{lib=l;$('lib').innerHTML=l.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.emoji+' '+x.name+' ('+x.kind+')')+'</option>').join('')});
sock.on('roster',r=>{ro=r;const t=r.names.length?'Jogadores: '+r.names.join(', '):'Nenhum jogador ainda.';$('ros').textContent=$('ros2').textContent=t;$('go').textContent=r.playing?'■ Encerrar sessão':'▶ Iniciar sessão'});
sock.on('me',m=>{at=m.at;showAt()});
sock.on('dialog',d=>{dl={d:d,i:0};showDl()});
sock.on('journal',j=>{jr=j;$('jr').innerHTML='<b>Diário de investigação</b>'+(j.length?j.map(x=>'<p><b>'+esc(x.t)+'</b><br>'+esc(x.x)+'</p>').join(''):'<p><small>Nenhuma pista descoberta.</small></p>')});
let tt;sock.on('toast',t=>{const e=$('toast');e.textContent=t;e.style.opacity=1;clearTimeout(tt);tt=setTimeout(()=>e.style.opacity=0,3500)});
sock.on('fx',f=>{f.t0=performance.now();fx.push(f)});
function showAt(){const sum=AT.reduce((a,k)=>a+at[k],0);
 $('atb').innerHTML=AT.map(k=>'<div><b>'+k+'</b><button data-a="'+k+'" data-d="-1">−</button> '+at[k]+' <button data-a="'+k+'" data-d="1">+</button></div>').join('')+'<small>Pontos restantes: '+(10-sum)+'</small>';
 $('der').textContent='Vida '+(12+at.VIG*4)+' · Dano '+(2+at.FOR*2)+' · Velocidade '+(90+at.AGI*14)+' · INT e PRE são narrativos por enquanto';}
$('atb').onclick=e=>{const k=e.target.dataset.a;if(!k)return;const n=Object.assign({},at);n[k]+=+e.target.dataset.d;if(n[k]<0||n[k]>5||AT.reduce((a,x)=>a+n[x],0)>10)return;sock.emit('attrs',n)};
function showDl(){if(!dl)return;const l=dl.d.lines[dl.i];$('dlg').hidden=false;$('dlg').innerHTML='<b>'+esc(dl.d.emoji+' '+dl.d.name)+'</b><p>'+esc(l)+'</p><button id="dn">'+(dl.i<dl.d.lines.length-1?'Próxima ▸':'Fechar')+'</button>';$('dn').onclick=nextDl}
function nextDl(){if(!dl)return;if(++dl.i>=dl.d.lines.length){dl=null;$('dlg').hidden=true}else showDl()}
function attack(a){if(me.role==='p'&&map)sock.emit('attack',{a:a})}
function interact(){if(dl)nextDl();else if(me.role==='p'&&map)sock.emit('interact')}
$('bA').onpointerdown=e=>{e.stopPropagation();attack()};$('bE').onpointerdown=e=>{e.stopPropagation();interact()};
addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;const k=e.key.toLowerCase();down.add(k);
 if(k===' '){attack();e.preventDefault()}if(k==='e')interact();if(k.startsWith('arrow'))e.preventDefault()});
addEventListener('keyup',e=>down.delete(e.key.toLowerCase()));
const ax=(a,b)=>(down.has(a[0])||down.has(a[1])?1:0)-(down.has(b[0])||down.has(b[1])?1:0);
setInterval(()=>{if(me.role!=='p'||!map)return;const kx=ax(['d','arrowright'],['a','arrowleft']),ky=ax(['s','arrowdown'],['w','arrowup']);
 const x=kx||jx,y=ky||jy,s=x.toFixed(2)+','+y.toFixed(2);if(s!==last){last=s;sock.emit('input',{x:x,y:y})}},50);
// joystick
(()=>{const j=$('joy'),k=$('knob');let id=null;
 const mv=e=>{const r=j.getBoundingClientRect();let dx=e.clientX-(r.left+60),dy=e.clientY-(r.top+60);const l=Math.hypot(dx,dy),m=48;if(l>m){dx*=m/l;dy*=m/l}
  jx=dx/m;jy=dy/m;k.style.transform='translate('+dx+'px,'+dy+'px)'};
 j.onpointerdown=e=>{id=e.pointerId;j.setPointerCapture(id);mv(e)};j.onpointermove=e=>{if(e.pointerId===id)mv(e)};
 j.onpointerup=j.onpointercancel=()=>{id=null;jx=jy=0;k.style.transform=''}})();
// editor do mestre
function setTool(t){tool=t;document.querySelectorAll('#tools button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));$('tiles').hidden=t!=='paint';$('libw').hidden=t!=='place'}
$('tools').onclick=e=>{if(e.target.dataset.t)setTool(e.target.dataset.t)};
$('tiles').innerHTML=COL.map((c,i)=>'<button data-i="'+i+'" title="'+TN[i]+'" style="background:'+c+'"></button>').join('');
$('tiles').onclick=e=>{if(e.target.dataset.i)tile=+e.target.dataset.i};
const near=(p,r)=>{let b=null,bd=r;for(const o of os){const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<bd){bd=d;b=o}}return b};
function act(p){const cx=Math.floor(p.x/TS),cy=Math.floor(p.y/TS);
 if(tool==='paint'){const k=cy*W+cx;if(k===lc||cx<0||cy<0||cx>=W||cy>=H)return;lc=k;sock.emit('map:paint',{x:cx,y:cy,t:tile})}
 else if(tool==='place'){const t=lib.find(l=>l.id===$('lib').value);if(!t)return;const o=Object.assign({},t);delete o.id;o.x=(cx+.5)*TS;o.y=(cy+.5)*TS;sock.emit('obj:put',{obj:o})}
 else if(tool==='del'){const o=near(p,22);if(o){sock.emit('obj:del',o.id);if(sel===o.id){sel=null;insp()}}}
 else if(tool==='sel'){const o=near(p,22);sel=o?o.id:null;insp()}}
const cv=$('cv'),wp=e=>({x:(e.clientX-innerWidth/2)/Z+cam.x,y:(e.clientY-innerHeight/2)/Z+cam.y});
cv.onpointerdown=e=>{if(!map)return;cv.setPointerCapture(e.pointerId);
 if(me.role==='p'){attack(Math.atan2(e.clientY-innerHeight/2,e.clientX-innerWidth/2));return}
 drag={x:e.clientX,y:e.clientY};lc=-1;act(wp(e))};
cv.onpointermove=e=>{if(!drag)return;if(tool==='hand'){cam.x-=(e.clientX-drag.x)/Z;cam.y-=(e.clientY-drag.y)/Z;drag.x=e.clientX;drag.y=e.clientY}else if(tool==='paint')act(wp(e))};
cv.onpointerup=()=>{drag=null};
function insp(){const el=$('insp'),o=os.find(x=>x.id===sel);
 if(!o){el.innerHTML='<small>Use ✏️ e toque em um objeto para editar suas propriedades.</small>';return}
 const k=o.kind,L=(n,l,t,v)=>'<label>'+l+(t==='area'?'<textarea data-k="'+n+'">'+esc(v)+'</textarea>':'<input data-k="'+n+'" type="'+t+'" '+(t==='checkbox'?(v?'checked':''):'value="'+esc(v)+'"')+'>')+'</label>';
 let h='<b>'+esc(o.emoji+' '+k)+'</b>'+L('name','Nome','text',o.name)+L('emoji','Emoji','text',o.emoji)+L('color','Cor','color',o.color||'#cccccc');
 if(k==='npc')h+=L('dialog','Falas (uma por linha)','area',(o.dialog||[]).join('\n'));
 if(k==='enemy')h+=L('hp','Vida','number',o.maxhp)+L('atk','Ataque','number',o.atk)+L('spd','Velocidade','number',o.spd);
 if(k==='prop')h+=L('solid','Bloqueia passagem','checkbox',o.solid);
 if(k==='clue')h+=L('text','Informação (revelada ao examinar)','area',o.text);
 if(k==='trigger')h+=L('msg','Mensagem do evento','text',o.msg)+'<label>Inimigo gerado<select data-k="spawn">'+lib.filter(l=>l.kind==='enemy').map(l=>'<option value="'+esc(l.id)+'"'+(l.id===o.spawn?' selected':'')+'>'+esc(l.name)+'</option>').join('')+'</select></label>'+L('count','Quantidade','number',o.count)+L('r','Raio de ativação','number',o.r)+L('reset','Reativar agora','checkbox',false);
 if(k!=='trigger'&&k!=='spawn')h+=L('vis','Visível aos jogadores','checkbox',!o.hidden);
 h+=L('note','Notas secretas (só o mestre vê)','area',o.note)+'<div style="display:flex;gap:6px;margin-top:6px"><button id="ap" style="flex:1">Aplicar</button><button id="sv">Salvar modelo</button></div>';
 el.innerHTML=h;
 const get=()=>{const r={id:o.id};el.querySelectorAll('[data-k]').forEach(i=>{const n=i.dataset.k;let v=i.type==='checkbox'?i.checked:i.type==='number'?+i.value:i.value;
  if(n==='dialog')v=v.split(/\r?\n/);if(n==='vis'){r.hidden=!v}else r[n]=v});return r};
 $('ap').onclick=()=>sock.emit('obj:put',{obj:get()});
 $('sv').onclick=()=>{const r=get();r.kind=k;sock.emit('lib:save',{obj:r})}}
$('go').onclick=()=>sock.emit(ro.playing?'game:stop':'game:start');
$('heal').onclick=()=>sock.emit('heal');
$('diff').onchange=e=>sock.emit('diff',+e.target.value);
$('bsay').onclick=()=>{sock.emit('say',$('say').value);$('say').value=''};
$('exp').onclick=()=>sock.emit('camp:export',j=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([j],{type:'application/json'}));a.download='campanha.json';a.click()});
$('imp').onclick=()=>$('file').click();
$('file').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>sock.emit('camp:import',r.result,x=>{const t=$('toast');t.textContent=x.err||'Campanha importada';t.style.opacity=1;setTimeout(()=>t.style.opacity=0,2500);sel=null;insp()});r.readAsText(f);e.target.value=''};
// renderização
function sm(id,x,y){const d=disp[id]||(disp[id]={x:x,y:y});if(Math.abs(d.x-x)+Math.abs(d.y-y)>120){d.x=x;d.y=y}d.x+=(x-d.x)*.35;d.y+=(y-d.y)*.35;return d}
function bar(c,x,y,w,f,col){c.fillStyle='#000a';c.fillRect(x-w/2,y,w,4);c.fillStyle=col;c.fillRect(x-w/2,y,w*Math.max(0,f),4)}
function draw(){requestAnimationFrame(draw);if($('game').hidden)return;
 const w=cv.width=innerWidth,h=cv.height=innerHeight,c=cv.getContext('2d');c.fillStyle='#000';c.fillRect(0,0,w,h);if(!map)return;
 Z=Math.max(.9,Math.min(1.6,w/560));const M=me.role==='m',mine=ps.find(p=>p.id===me.pid);
 if(mine){const d=sm('me',mine.x,mine.y);cam.x=d.x;cam.y=d.y}else if(M&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){cam.x+=ax(['d','arrowright'],['a','arrowleft'])*8;cam.y+=ax(['s','arrowdown'],['w','arrowup'])*8}
 c.save();c.translate(w/2,h/2);c.scale(Z,Z);c.translate(-cam.x,-cam.y);
 const x0=Math.max(0,Math.floor((cam.x-w/2/Z)/TS)),x1=Math.min(W-1,Math.ceil((cam.x+w/2/Z)/TS)),y0=Math.max(0,Math.floor((cam.y-h/2/Z)/TS)),y1=Math.min(H-1,Math.ceil((cam.y+h/2/Z)/TS));
 for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const t=map.tiles[y*W+x];c.fillStyle=COL[t];c.fillRect(x*TS,y*TS,TS,TS);
  if(t===2){c.fillStyle='#ffffff14';c.fillRect(x*TS,y*TS,TS,6)}else if(M){c.strokeStyle='#ffffff0d';c.strokeRect(x*TS,y*TS,TS,TS)}}
 c.textAlign='center';c.textBaseline='middle';
 for(const o of os){const d=sm(o.id,o.x,o.y),hid=o.hidden||o.kind==='trigger'||o.kind==='spawn';c.globalAlpha=hid?.5:1;
  if(o.kind==='trigger'){c.setLineDash([5,5]);c.strokeStyle='#ff6';c.beginPath();c.arc(d.x,d.y,o.r,0,7);c.stroke();c.setLineDash([])}
  if(o.kind==='enemy'||o.kind==='npc'){c.fillStyle=(o.color||'#ccc')+'55';c.beginPath();c.arc(d.x,d.y,14,0,7);c.fill()}
  c.font='24px serif';c.fillText(o.emoji||'?',d.x,d.y);c.globalAlpha=1;
  if(o.id===sel){c.strokeStyle='#fff';c.strokeRect(d.x-16,d.y-16,32,32)}
  if(o.kind==='enemy'&&(o.hp<o.maxhp||M))bar(c,d.x,d.y-22,28,o.hp/o.maxhp,'#d23a4c');
  if(o.kind==='npc'||o.kind==='enemy'||(M&&o.kind!=='prop')){c.font='10px sans-serif';c.fillStyle='#fff';c.fillText(o.name,d.x,d.y+20)}}
 for(const p of ps){const d=p.id===me.pid?{x:p.x,y:p.y}:sm(p.id,p.x,p.y);
  if(p.dead){c.font='22px serif';c.fillText('💀',d.x,d.y);continue}
  c.fillStyle=p.color;c.beginPath();c.arc(d.x,d.y,11,0,7);c.fill();c.strokeStyle='#000';c.lineWidth=2;c.stroke();
  c.strokeStyle='#fff';c.beginPath();c.moveTo(d.x,d.y);c.lineTo(d.x+Math.cos(p.dir)*15,d.y+Math.sin(p.dir)*15);c.stroke();
  bar(c,d.x,d.y-20,26,p.hp/p.maxhp,'#4c4');c.font='10px sans-serif';c.fillStyle='#fff';c.fillText(p.name,d.x,d.y+20)}
 const now=performance.now();fx=fx.filter(f=>now-f.t0<700);
 for(const f of fx){const a=(now-f.t0)/700;
  if(f.t==='slash'){c.strokeStyle='rgba(255,255,255,'+(1-a*1.5)+')';c.lineWidth=3;c.beginPath();c.arc(f.x,f.y,18,f.a-1,f.a+1);c.stroke()}
  else{c.globalAlpha=1-a;c.font='bold 16px sans-serif';c.fillStyle=f.c;c.fillText(f.v,f.x,f.y-14-a*24);c.globalAlpha=1}}
 c.restore();
 if(me.role==='p'){const g=c.createRadialGradient(w/2,h/2,Math.min(w,h)*.25,w/2,h/2,Math.max(w,h)*.7);g.addColorStop(0,'#0000');g.addColorStop(1,'#000c');c.fillStyle=g;c.fillRect(0,0,w,h)}}
draw();
</script></body></html>`; }
