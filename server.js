'use strict';
// ENGINE: servidor autoritativo (movimento, combate, mapas, portas, eventos, visibilidade) + cliente embutido (PAGE).
// BIBLIOTECA: BASE (modelos padrão) + modelos salvos pelo mestre (room.lib).
// CAMPANHA: vários mapas ligados por portas, cada um com terreno e objetos; exportável em JSON.
const http = require('http'), crypto = require('crypto'), { Server } = require('socket.io');
const PORT = process.env.PORT || 3000, TS = 32, MAXW = 80, MAXH = 60, NT = 8, SOLID = [2, 3, 7];
const KINDS = ['npc', 'enemy', 'prop', 'clue', 'event', 'spawn', 'door'];
const ACTS = ['say', 'dialog', 'spawn', 'tp', 'show', 'lock', 'heal', 'hurt', 'clue'];
const PSPR = ['investigador', 'ocultista', 'soldado', 'medica', 'policial'];

const BASE = [
  { id: 'zumbi', kind: 'enemy', name: 'Zumbi', spr: 'zumbi', hp: 20, atk: 4, spd: 55 },
  { id: 'esqueleto', kind: 'enemy', name: 'Esqueleto', spr: 'esqueleto', hp: 14, atk: 5, spd: 75 },
  { id: 'cultista', kind: 'enemy', name: 'Cultista', spr: 'cultista', hp: 14, atk: 5, spd: 80 },
  { id: 'sombra', kind: 'enemy', name: 'Sombra', spr: 'sombra', hp: 16, atk: 6, spd: 90 },
  { id: 'cao', kind: 'enemy', name: 'Cão infernal', spr: 'cao', hp: 18, atk: 6, spd: 110 },
  { id: 'olho', kind: 'enemy', name: 'Olho flutuante', spr: 'olho', hp: 30, atk: 7, spd: 50 },
  { id: 'criatura', kind: 'enemy', name: 'Criatura do Outro Lado', spr: 'criatura', hp: 45, atk: 9, spd: 65 },
  { id: 'npc_aldeao', kind: 'npc', name: 'Sobrevivente', spr: 'aldeao', dialog: ['Você viu aquilo? Não saia sozinho.'] },
  { id: 'npc_padre', kind: 'npc', name: 'Padre', spr: 'padre', dialog: ['Esta casa guarda algo que não deveria ser acordado.'] },
  { id: 'npc_policial', kind: 'npc', name: 'Policial', spr: 'policial', dialog: ['Isolamos a área. Ninguém passa sem autorização.'] },
  { id: 'npc_medica', kind: 'npc', name: 'Médica', spr: 'medica', dialog: ['Fique perto de mim se estiver ferido.'] },
  { id: 'npc_ocultista', kind: 'npc', name: 'Ocultista', spr: 'ocultista', dialog: ['O Outro Lado responde a quem sabe chamar.'] },
  { id: 'caixa', kind: 'prop', name: 'Caixote', spr: 'caixa', solid: true },
  { id: 'barril', kind: 'prop', name: 'Barril', spr: 'barril', solid: true },
  { id: 'bau', kind: 'prop', name: 'Baú', spr: 'bau', solid: true },
  { id: 'mesa', kind: 'prop', name: 'Mesa', spr: 'mesa', solid: true },
  { id: 'cama', kind: 'prop', name: 'Cama', spr: 'cama', solid: true },
  { id: 'estante', kind: 'prop', name: 'Estante', spr: 'estante', solid: true },
  { id: 'arvore', kind: 'prop', name: 'Árvore', spr: 'arvore', solid: true },
  { id: 'lapide', kind: 'prop', name: 'Lápide', spr: 'lapide', solid: true },
  { id: 'altar', kind: 'prop', name: 'Altar', spr: 'altar', solid: true },
  { id: 'tocha', kind: 'prop', name: 'Tocha', spr: 'tocha' },
  { id: 'papel', kind: 'clue', name: 'Bilhete', spr: 'papel', text: 'Escreva aqui a informação da pista.', hidden: true },
  { id: 'diario', kind: 'clue', name: 'Diário', spr: 'diario', text: 'Escreva aqui o conteúdo do diário.', hidden: true },
  { id: 'chave', kind: 'clue', name: 'Chave', spr: 'chave', text: 'Uma chave antiga. Abre algo importante.', hidden: true },
  { id: 'porta', kind: 'door', name: 'Porta', spr: 'porta', to: '', tx: -1, ty: -1, group: true },
  { id: 'escada', kind: 'door', name: 'Escada', spr: 'escada', to: '', tx: -1, ty: -1, group: true },
  { id: 'portal', kind: 'door', name: 'Portal', spr: 'portal', to: '', tx: -1, ty: -1, group: true },
  { id: 'gatilho', kind: 'event', name: 'Emboscada', spr: 'runa', when: 'enter', r: 64, once: true, hidden: true,
    acts: [{ t: 'say', text: 'Algo se move nas sombras...' }, { t: 'spawn', lib: 'zumbi', count: 2 }] },
  { id: 'alavanca', kind: 'event', name: 'Alavanca', spr: 'alavanca', when: 'interact', r: 40, once: true,
    acts: [{ t: 'say', text: 'Você ouve um clique distante.' }] },
  { id: 'inicio', kind: 'spawn', name: 'Início', spr: 'bandeira' }
];

const rooms = new Map();
const rnd = n => Math.random() * n, uid = () => crypto.randomBytes(8).toString('hex');
const cl = (v, a, b) => Math.min(b, Math.max(a, +v || 0));
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const libOf = r => BASE.concat(r.lib);
const mapPub = m => ({ id: m.id, name: m.name, w: m.w, h: m.h, tiles: m.tiles });

function cleanActs(a) {
  return (Array.isArray(a) ? a : []).slice(0, 20).map(x => x || {}).map(x => ({
    t: ACTS.includes(x.t) ? x.t : 'say', text: str(x.text, 300), name: str(x.name, 40), spr: str(x.spr, 20),
    lines: (Array.isArray(x.lines) ? x.lines : []).slice(0, 20).map(s => str(s, 300)).filter(Boolean),
    lib: str(x.lib, 30), count: cl(x.count, 0, 10), map: str(x.map, 12), x: cl(x.x, -1, MAXW), y: cl(x.y, -1, MAXH),
    target: str(x.target, 12), v: typeof x.v === 'boolean' ? x.v : cl(x.v, 0, 999)
  }));
}
// Normaliza/valida um objeto vindo do mestre (cria ou atualiza `old`).
function clean(o, old) {
  o = o || {};
  const k = KINDS.includes(o.kind) ? o.kind : old && old.kind;
  if (!k) return null;
  const r = old || { id: null, kind: k };
  const g = (f, d) => o[f] != null ? o[f] : r[f] != null ? r[f] : d;
  r.x = cl(g('x', 0), 0, MAXW * TS); r.y = cl(g('y', 0), 0, MAXH * TS);
  r.name = str(g('name', ''), 40);
  const sp = g('spr', ''); r.spr = /^[a-z_]{1,20}$/.test(sp) ? sp : 'caixa';
  r.note = str(g('note', ''), 500); r.text = str(g('text', ''), 1500);
  r.hidden = k === 'spawn' ? true : !!g('hidden', false);
  r.solid = !!g('solid', false);
  r.dialog = (Array.isArray(o.dialog) ? o.dialog : r.dialog || []).slice(0, 30).map(s => str(s, 300)).filter(Boolean);
  if (k === 'enemy') {
    const hp = cl(g('hp', g('maxhp', 20)), 1, 9999);
    if (!r.maxhp || o.hp != null) { r.maxhp = hp; r.hp = hp; }
    r.atk = cl(g('atk', 4), 0, 999); r.spd = cl(g('spd', 60), 0, 200);
  }
  if (k === 'door') {
    r.to = str(g('to', ''), 12); r.tx = Math.floor(cl(g('tx', -1), -1, MAXW)); r.ty = Math.floor(cl(g('ty', -1), -1, MAXH));
    r.group = !!g('group', true); r.locked = !!g('locked', false);
  }
  if (k === 'event') {
    const w = g('when', 'enter'); r.when = ['enter', 'interact', 'clear'].includes(w) ? w : 'enter';
    r.r = cl(g('r', 64), 16, 400); r.once = !!g('once', true);
    if (o.reset) r.done = false;
    r.acts = cleanActs(o.acts != null ? o.acts : r.acts);
  }
  return r;
}
function addObj(r, m, d) {
  if (m.objs.length >= 300) return null;
  const n = clean(d); if (!n) return null;
  n.id = 'o' + r.seq++; m.objs.push(n); return n;
}
// O que o jogador pode ver: nada de ocultos, início, notas, textos de pista ou ações de evento.
const pubObj = o => o.kind === 'spawn' || o.hidden ? null :
  { id: o.id, kind: o.kind, x: Math.round(o.x), y: Math.round(o.y), name: o.name, spr: o.spr, solid: o.solid, hp: o.hp, maxhp: o.maxhp };

// ---- geração de cenários ----
function gen(tpl, w, h) {
  const t = new Array(w * h).fill(tpl === 'casa' ? 1 : tpl === 'cripta' ? 5 : 0), os = [];
  const S = (x, y, v) => { if (x >= 0 && y >= 0 && x < w && y < h) t[y * w + x] = v; };
  const bd = tpl === 'floresta' ? 7 : 2, cx = w >> 1, cy = h >> 1;
  for (let i = 0; i < w; i++) { S(i, 0, bd); S(i, h - 1, bd); }
  for (let j = 0; j < h; j++) { S(0, j, bd); S(w - 1, j, bd); }
  if (tpl === 'casa') {
    for (let i = 1; i < w - 1; i++) S(i, cy, 2);
    for (let j = 1; j < h - 1; j++) S(cx, j, 2);
    [[cx, cy >> 1], [cx, cy + ((h - cy) >> 1)], [cx >> 1, cy], [cx + ((w - cx) >> 1), cy]].forEach(g => S(g[0], g[1], 1));
  }
  if (tpl === 'floresta') {
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= 9) S((w >> 2) + x, (h >> 2) + y, 3);
    for (let i = 1; i < w - 1; i++) { const y = cy + Math.round(Math.sin(i / 4) * 2); S(i, y, 6); S(i, y + 1, 6); }
    for (let i = 0, n = (w * h / 28) | 0; i < n; i++) {
      const x = 1 + (rnd(w - 2) | 0), y = 1 + (rnd(h - 2) | 0);
      if (t[y * w + x] === 0 && Math.hypot(x - cx, y - cy) > 3) os.push(Object.assign({}, BASE.find(b => b.id === 'arvore'), { x: (x + .5) * TS, y: (y + .5) * TS }));
    }
  }
  if (tpl === 'cripta') {
    for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) { const d = Math.hypot(x, y); if (d <= 5 && d >= 3.5) S(cx + x, cy + y, 4); }
    [[-8, -6], [8, -6], [-8, 6], [8, 6]].forEach(g => { S(cx + g[0], cy + g[1], 2); S(cx + g[0] + 1, cy + g[1], 2); });
  }
  return { tiles: t, objs: os };
}
function newMap(r, name, tpl, w, h) {
  const g = gen(tpl, w, h), m = { id: 'm' + r.mseq++, name, w, h, tiles: g.tiles, objs: [], seen: false };
  r.maps[m.id] = m;
  g.objs.forEach(o => addObj(r, m, o));
  addObj(r, m, Object.assign({}, BASE.find(b => b.id === 'inicio'), { x: (w >> 1) * TS + TS / 2, y: (h >> 1) * TS + TS / 2 }));
  return m;
}

// ---- simulação ----
const blocked = (m, x, y) => {
  const c = Math.floor(x / TS), d = Math.floor(y / TS);
  if (c < 0 || d < 0 || c >= m.w || d >= m.h || SOLID.includes(m.tiles[d * m.w + c])) return true;
  return m.objs.some(o => o.solid && Math.abs(o.x - x) < 16 && Math.abs(o.y - y) < 16);
};
const move = (m, e, dx, dy) => { if (!blocked(m, e.x + dx, e.y)) e.x += dx; if (!blocked(m, e.x, e.y + dy)) e.y += dy; };
const inMap = (r, id) => Object.values(r.players).filter(p => p.in && p.map === id);
// Envia a quem está no mapa `id` (jogadores) e ao mestre se ele estiver vendo esse mapa.
const tm = (r, id, ev, d, master = true) => {
  inMap(r, id).forEach(p => p.sid && io.to(p.sid).emit(ev, d));
  if (master && r.msid && r.mview === id) io.to(r.msid).emit(ev, d);
};
const pushMap = (r, m) => {
  const p = mapPub(m);
  if (r.msid && r.mview === m.id) io.to(r.msid).emit('map', p);
  inMap(r, m.id).forEach(q => q.sid && io.to(q.sid).emit('map', p));
};
const emitMaps = r => r.msid && io.to(r.msid).emit('maps', { list: Object.values(r.maps).map(m => ({ id: m.id, name: m.name })), start: r.start, view: r.mview });
const roster = r => io.to(r.code).emit('roster', {
  names: Object.values(r.players).map(p => p.name + (p.in && r.maps[p.map] ? ' @' + r.maps[p.map].name : '') + (p.sid ? '' : ' (off)')), playing: r.playing
});
const addJ = (r, id, t, x) => { if (!r.journal.some(j => j.id === id)) { r.journal.push({ id, t, x }); io.to(r.code).emit('journal', r.journal); } };

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
function derive(p) { p.maxhp = 12 + p.at.VIG * 4; p.atk = 2 + p.at.FOR * 2; p.spd = 90 + p.at.AGI * 14; p.def = Math.floor(p.at.VIG / 2); }
function newP(r, pid, sid, name, n) {
  const p = { pid, sid, name, map: r.start, spr: PSPR[n % PSPR.length], color: COLORS[n % COLORS.length], at: { FOR: 2, AGI: 2, INT: 1, PRE: 1, VIG: 2 }, x: 0, y: 0, ix: 0, iy: 0, dir: 0, cd: 0, dead: false, rt: 0, in: false };
  derive(p); p.hp = p.maxhp; return p;
}
// Move o jogador para um mapa (tx,ty em células; <0 = ponto de início do mapa).
function goto(r, p, mid, tx, ty) {
  const m = r.maps[mid]; if (!m) return;
  const sp = m.objs.find(o => o.kind === 'spawn');
  p.map = mid; p.ix = p.iy = 0; p.in = true;
  p.x = (tx >= 0 && ty >= 0 ? (tx + .5) * TS : sp ? sp.x : m.w * TS / 2) + rnd(10) - 5;
  p.y = (tx >= 0 && ty >= 0 ? (ty + .5) * TS : sp ? sp.y : m.h * TS / 2) + rnd(10) - 5;
  if (p.sid) io.to(p.sid).emit('map', mapPub(m));
}
function spawnP(r, p) { goto(r, p, r.start, -1, -1); p.hp = p.maxhp; p.dead = false; }
const hurt = (r, p, d) => {
  p.hp -= d; tm(r, p.map, 'fx', { t: 'dmg', x: p.x, y: p.y, v: d, c: '#ff5555' });
  if (p.hp <= 0) { p.hp = 0; p.dead = true; p.rt = 8; tm(r, p.map, 'toast', p.name + ' caiu!'); }
};
// Executa as ações de um evento no mapa m.
function run(r, m, o) {
  for (const a of o.acts || []) {
    const ps = inMap(r, m.id);
    if (a.t === 'say') tm(r, m.id, 'toast', a.text);
    else if (a.t === 'dialog') tm(r, m.id, 'dialog', { name: a.name, spr: a.spr, lines: a.lines.length ? a.lines : ['...'] }, false);
    else if (a.t === 'spawn') {
      const t = libOf(r).find(l => l.id === a.lib && l.kind === 'enemy');
      if (t) for (let i = 0; i < a.count; i++) { const e = Object.assign({}, t, { x: o.x + rnd(80) - 40, y: o.y + rnd(80) - 40 }); delete e.id; addObj(r, m, e); }
    } else if (a.t === 'tp') ps.forEach(p => goto(r, p, a.map, a.x, a.y));
    else if (a.t === 'show') { const t = m.objs.find(x => x.id === a.target); if (t && t.kind !== 'spawn') t.hidden = !a.v; }
    else if (a.t === 'lock') { const t = m.objs.find(x => x.id === a.target && x.kind === 'door'); if (t) t.locked = !!a.v; }
    else if (a.t === 'heal') ps.forEach(p => { p.hp = p.maxhp; p.dead = false; });
    else if (a.t === 'hurt') ps.forEach(p => { if (!p.dead) hurt(r, p, a.v); });
    else if (a.t === 'clue') addJ(r, o.id + ':' + a.name, a.name || 'Pista', a.text);
  }
}
const fire = (r, m, o) => { if (o.once) o.done = true; run(r, m, o); };

function step(r, dt) {
  if (!r.playing) return;
  const all = Object.values(r.players).filter(p => p.in);
  for (const p of all) {
    const m = r.maps[p.map]; if (!m) continue;
    if (p.dead) { if ((p.rt -= dt) <= 0) spawnP(r, p); continue; }
    p.cd = Math.max(0, p.cd - dt);
    const l = Math.hypot(p.ix, p.iy);
    if (l > 0) { const dx = p.ix / l, dy = p.iy / l; move(m, p, dx * p.spd * dt, dy * p.spd * dt); p.dir = Math.atan2(dy, dx); }
  }
  for (const m of Object.values(r.maps)) {
    const ps = all.filter(p => p.map === m.id); if (!ps.length) continue;
    let en = 0;
    for (const o of m.objs.slice()) {
      if (o.kind === 'enemy') {
        en++; o.cd = Math.max(0, (o.cd || 0) - dt);
        let t = null, bd = 260;
        for (const p of ps) { if (p.dead) continue; const d = Math.hypot(p.x - o.x, p.y - o.y); if (d < bd) { bd = d; t = p; } }
        if (!t) continue;
        if (bd > 26) { const a = Math.atan2(t.y - o.y, t.x - o.x); move(m, o, Math.cos(a) * o.spd * dt, Math.sin(a) * o.spd * dt); }
        else if (o.cd <= 0) { o.cd = 1; hurt(r, t, Math.max(1, Math.round(o.atk * r.diff) - t.def)); }
      } else if (o.kind === 'event' && !o.done && o.when === 'enter' && ps.some(p => !p.dead && Math.hypot(p.x - o.x, p.y - o.y) < o.r)) fire(r, m, o);
    }
    if (en > 0) m.seen = true;
    else if (m.seen) { m.seen = false; m.objs.filter(o => o.kind === 'event' && o.when === 'clear' && !o.done).forEach(o => fire(r, m, o)); }
  }
}
const playersPub = (r, id) => inMap(r, id).map(p => ({ id: p.pid, name: p.name, x: Math.round(p.x), y: Math.round(p.y), hp: p.hp, maxhp: p.maxhp, dir: p.dir, dead: p.dead, color: p.color, spr: p.spr }));
function send(r) {
  const mm = r.maps[r.mview];
  if (r.msid && mm) io.to(r.msid).emit('tick', { ps: playersPub(r, mm.id), os: mm.objs });
  if (!r.playing) return;
  const cache = {};
  for (const p of Object.values(r.players)) {
    if (!p.sid || !p.in) continue;
    const c = cache[p.map] || (cache[p.map] = { ps: playersPub(r, p.map), os: r.maps[p.map] ? r.maps[p.map].objs.map(pubObj).filter(Boolean) : [] });
    io.to(p.sid).emit('tick', c);
  }
}

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
  const initM = r => { s.emit('map', mapPub(r.maps[r.mview])); emitMaps(r); s.emit('lib', libOf(r)); s.emit('journal', r.journal); roster(r); };
  const initP = (r, p) => {
    p.off = 0; s.emit('me', { at: p.at, spr: p.spr }); s.emit('journal', r.journal);
    if (r.playing) { if (!p.in) spawnP(r, p); else s.emit('map', mapPub(r.maps[p.map] || r.maps[r.start])); }
    roster(r);
  };

  s.on('room:create', (d, cb) => {
    if (rooms.size > 60) return cb({ err: 'Servidor cheio' });
    let c; do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[rnd(23) | 0]).join(''); while (rooms.has(c));
    const r = { code: c, master: uid(), msid: s.id, players: {}, maps: {}, mseq: 1, seq: 1, lib: [], journal: [], playing: false, diff: 1, idle: 0 };
    r.start = r.mview = newMap(r, 'Mapa 1', 'vazio', 40, 28).id;
    rooms.set(c, r); enter(r, r.master);
    cb({ ok: 1, code: c, pid: r.master, role: 'm' }); initM(r);
  });
  s.on('room:join', (d, cb) => {
    const r = rooms.get(str(d && d.code, 4).toUpperCase());
    if (!r) return cb({ err: 'Sala não encontrada' });
    if (Object.keys(r.players).length >= 12) return cb({ err: 'Sala cheia' });
    const pid = uid(), p = newP(r, pid, s.id, str(d.name, 16).trim() || 'Agente', Object.keys(r.players).length);
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
    p.at = n; derive(p); p.hp = p.maxhp; s.emit('me', { at: n, spr: p.spr });
  });
  s.on('look', d => { const { p } = C(); if (p && d && PSPR.includes(d.spr)) { p.spr = d.spr; s.emit('me', { at: p.at, spr: p.spr }); } });
  s.on('input', d => { const { p } = C(); if (p && p.in && d) { p.ix = cl(d.x, -1, 1); p.iy = cl(d.y, -1, 1); } });
  s.on('attack', d => {
    const { r, p } = C(); if (!p || !p.in || p.dead || p.cd > 0) return;
    const m = r.maps[p.map]; if (!m) return;
    p.cd = 0.5; if (d && Number.isFinite(d.a)) p.dir = d.a;
    const ax = p.x + Math.cos(p.dir) * 26, ay = p.y + Math.sin(p.dir) * 26;
    tm(r, m.id, 'fx', { t: 'slash', x: ax, y: ay, a: p.dir });
    for (const o of m.objs.slice()) {
      if (o.kind !== 'enemy' || Math.hypot(o.x - ax, o.y - ay) > 42) continue;
      const dmg = p.atk + (rnd(3) | 0); o.hp -= dmg;
      tm(r, m.id, 'fx', { t: 'dmg', x: o.x, y: o.y, v: dmg, c: '#ffd34d' });
      if (o.hp <= 0) m.objs = m.objs.filter(x => x !== o);
    }
  });
  s.on('interact', () => {
    const { r, p } = C(); if (!p || !p.in || p.dead) return;
    const m = r.maps[p.map]; if (!m) return;
    let b = null, bd = 48;
    for (const o of m.objs) {
      if (o.hidden || !['npc', 'clue', 'door', 'event'].includes(o.kind) || (o.kind === 'event' && (o.when !== 'interact' || o.done))) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y); if (d < bd) { bd = d; b = o; }
    }
    if (!b) return;
    if (b.kind === 'npc') s.emit('dialog', { name: b.name, spr: b.spr, lines: b.dialog.length ? b.dialog : ['...'] });
    else if (b.kind === 'clue') { s.emit('dialog', { name: b.name, spr: b.spr, lines: [b.text || '(sem informação)'] }); addJ(r, b.id, b.name, b.text); }
    else if (b.kind === 'event') fire(r, m, b);
    else {
      if (b.locked) return s.emit('toast', 'Está trancada.');
      if (!r.maps[b.to]) return s.emit('toast', 'Esta porta não leva a lugar nenhum.');
      (b.group ? inMap(r, m.id).filter(q => !q.dead) : [p]).forEach(q => goto(r, q, b.to, b.tx, b.ty));
    }
  });

  // ---- mestre ----
  const M = fn => (d, cb) => { const c = C(); if (c.r && c.m) fn(c.r, d, cb, c.r.maps[c.r.mview]); };
  s.on('map:paint', M((r, d, cb, m) => {
    const x = Math.floor(+d.x), y = Math.floor(+d.y), t = Math.floor(cl(d.t, 0, NT - 1));
    if (!(x >= 0 && y >= 0 && x < m.w && y < m.h)) return;
    m.tiles[y * m.w + x] = t; tm(r, m.id, 'tiles', { id: m.id, c: [[x, y, t]] });
  }));
  s.on('map:fill', M((r, d, cb, m) => {
    const x = Math.floor(+d.x), y = Math.floor(+d.y), t = Math.floor(cl(d.t, 0, NT - 1));
    if (!(x >= 0 && y >= 0 && x < m.w && y < m.h)) return;
    const from = m.tiles[y * m.w + x]; if (from === t) return;
    const st = [[x, y]];
    while (st.length) { const [a, b] = st.pop(); if (a < 0 || b < 0 || a >= m.w || b >= m.h || m.tiles[b * m.w + a] !== from) continue; m.tiles[b * m.w + a] = t; st.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]); }
    pushMap(r, m);
  }));
  s.on('map:rect', M((r, d, cb, m) => {
    const t = Math.floor(cl(d.t, 0, NT - 1)), x0 = Math.max(0, Math.floor(Math.min(d.x0, d.x1))), x1 = Math.min(m.w - 1, Math.floor(Math.max(d.x0, d.x1)));
    const y0 = Math.max(0, Math.floor(Math.min(d.y0, d.y1))), y1 = Math.min(m.h - 1, Math.floor(Math.max(d.y0, d.y1)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.tiles[y * m.w + x] = t;
    pushMap(r, m);
  }));
  s.on('map:new', M((r, d) => {
    if (Object.keys(r.maps).length >= 12) return s.emit('toast', 'Limite de 12 mapas.');
    const tpl = ['vazio', 'casa', 'floresta', 'cripta'].includes(d.tpl) ? d.tpl : 'vazio';
    const m = newMap(r, str(d.name, 30).trim() || 'Novo mapa', tpl, Math.floor(cl(d.w, 10, MAXW)), Math.floor(cl(d.h, 10, MAXH)));
    r.mview = m.id; s.emit('map', mapPub(m)); emitMaps(r);
  }));
  s.on('map:edit', M((r, d, cb, m) => {
    const w = Math.floor(cl(d.w, 10, MAXW)), h = Math.floor(cl(d.h, 10, MAXH)), t = new Array(w * h).fill(0);
    for (let y = 0; y < Math.min(h, m.h); y++) for (let x = 0; x < Math.min(w, m.w); x++) t[y * w + x] = m.tiles[y * m.w + x];
    m.tiles = t; m.w = w; m.h = h; m.name = str(d.name, 30).trim() || m.name;
    m.objs = m.objs.filter(o => o.x < w * TS && o.y < h * TS);
    inMap(r, m.id).forEach(p => { p.x = Math.min(p.x, w * TS - 20); p.y = Math.min(p.y, h * TS - 20); });
    pushMap(r, m); emitMaps(r); roster(r);
  }));
  s.on('map:del', M((r, d, cb, m) => {
    if (Object.keys(r.maps).length <= 1 || m.id === r.start) return s.emit('toast', 'Não dá para excluir o mapa inicial.');
    delete r.maps[m.id];
    Object.values(r.maps).forEach(x => x.objs.forEach(o => { if (o.kind === 'door' && o.to === m.id) o.to = ''; }));
    Object.values(r.players).forEach(p => { if (p.map === m.id) { if (p.in) goto(r, p, r.start, -1, -1); else p.map = r.start; } });
    r.mview = r.start; s.emit('map', mapPub(r.maps[r.start])); emitMaps(r); roster(r);
  }));
  s.on('map:start', M((r, d, cb, m) => { r.start = m.id; emitMaps(r); s.emit('toast', '"' + m.name + '" é o mapa inicial.'); }));
  s.on('map:view', M((r, d) => { if (d && r.maps[d.id]) { r.mview = d.id; s.emit('map', mapPub(r.maps[d.id])); emitMaps(r); } }));

  s.on('obj:put', M((r, d, cb, m) => {
    if (!d || !d.obj) return;
    const old = d.obj.id && m.objs.find(o => o.id === d.obj.id);
    const n = old ? clean(d.obj, old) : addObj(r, m, d.obj);
    if (n && n.kind === 'door' && d.obj.back && r.maps[n.to]) { // cria a porta de volta no mapa de destino
      const dm = r.maps[n.to], sp = dm.objs.find(o => o.kind === 'spawn');
      addObj(r, dm, {
        kind: 'door', name: 'Porta de volta', spr: n.spr, group: n.group, to: m.id, tx: Math.floor(n.x / TS), ty: Math.floor(n.y / TS),
        x: n.tx >= 0 ? (n.tx + .5) * TS : sp ? sp.x : dm.w * TS / 2, y: n.ty >= 0 ? (n.ty + .5) * TS : sp ? sp.y - TS : dm.h * TS / 2
      });
    }
  }));
  s.on('obj:del', M((r, id, cb, m) => { m.objs = m.objs.filter(o => o.id !== id); }));
  s.on('game:start', M(r => {
    r.playing = true;
    Object.values(r.maps).forEach(m => { m.seen = false; m.objs.forEach(o => { if (o.kind === 'event') o.done = false; }); });
    Object.values(r.players).forEach(p => spawnP(r, p)); roster(r);
  }));
  s.on('game:stop', M(r => {
    r.playing = false;
    Object.values(r.players).forEach(p => { p.in = false; p.hp = p.maxhp; p.dead = false; p.map = r.start; if (p.sid) io.to(p.sid).emit('stop'); });
    roster(r);
  }));
  s.on('heal', M(r => { Object.values(r.players).forEach(p => { p.hp = p.maxhp; p.dead = false; }); io.to(r.code).emit('toast', 'O grupo foi restaurado.'); }));
  s.on('say', M((r, t) => io.to(r.code).emit('toast', str(t, 200))));
  s.on('diff', M((r, v) => { r.diff = cl(v, 0.5, 3); }));
  s.on('lib:save', M((r, d) => {
    if (r.lib.length >= 40 || !d || !d.obj) return;
    const n = clean(Object.assign({}, d.obj, { x: 0, y: 0 })); if (!n) return;
    delete n.done; n.id = 'c' + r.seq++; r.lib.push(n); s.emit('lib', libOf(r));
  }));
  s.on('camp:export', M((r, d, cb) => cb && cb(JSON.stringify({ v: 2, start: r.start, maps: Object.values(r.maps).map(m => ({ id: m.id, name: m.name, w: m.w, h: m.h, tiles: m.tiles, objs: m.objs })), lib: r.lib }))));
  s.on('camp:import', M((r, d, cb) => {
    try {
      const j = JSON.parse(d);
      if (!Array.isArray(j.maps) || !j.maps.length || j.maps.length > 12) throw 0;
      const maps = {}, ids = new Set(); let mseq = 1;
      for (const x of j.maps) {
        const w = Math.floor(cl(x.w, 10, MAXW)), h = Math.floor(cl(x.h, 10, MAXH));
        if (!/^m\d{1,4}$/.test(x.id) || maps[x.id] || !Array.isArray(x.tiles) || x.tiles.length !== w * h) throw 0;
        const m = { id: x.id, name: str(x.name, 30), w, h, tiles: x.tiles.map(t => Math.floor(cl(t, 0, NT - 1))), objs: [], seen: false };
        for (const o of (x.objs || []).slice(0, 300)) {
          const n = clean(o); if (!n) continue;
          n.x = cl(n.x, 0, w * TS); n.y = cl(n.y, 0, h * TS);
          n.id = /^o\d{1,6}$/.test(o.id) && !ids.has(o.id) ? o.id : null; if (n.id) ids.add(n.id);
          m.objs.push(n);
        }
        maps[x.id] = m; mseq = Math.max(mseq, +x.id.slice(1) + 1);
      }
      let seq = 1; ids.forEach(i => { seq = Math.max(seq, +i.slice(1) + 1); });
      Object.values(maps).forEach(m => m.objs.forEach(o => { if (!o.id) o.id = 'o' + seq++; }));
      r.maps = maps; r.mseq = mseq; r.seq = seq; r.start = maps[j.start] ? j.start : Object.keys(maps)[0]; r.mview = r.start;
      r.lib = []; (j.lib || []).slice(0, 40).forEach(o => { const n = clean(o); if (n) { n.id = 'c' + r.seq++; r.lib.push(n); } });
      r.journal = []; io.to(r.code).emit('journal', []);
      Object.values(r.players).forEach(p => { if (p.in) goto(r, p, r.start, -1, -1); else p.map = r.start; });
      s.emit('map', mapPub(r.maps[r.mview])); emitMaps(r); s.emit('lib', libOf(r)); roster(r);
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
[hidden]{display:none!important}img{image-rendering:pixelated}
input,select,textarea,button{font:inherit;color:inherit;background:#17141f;border:1px solid #3b3350;border-radius:4px;padding:7px;min-width:0}
textarea{width:100%;height:58px;user-select:text}input{user-select:text}
button{cursor:pointer;background:#241a30}button:active,button.on{background:#8a1c2c;border-color:#c8394d}
h1{font:italic 700 26px Georgia,serif;letter-spacing:.04em;margin:0;color:#d23a4c}
.screen{display:flex;flex-direction:column;gap:10px;max-width:340px;margin:10vh auto;padding:20px}
.screen small{color:#8d86a0}#err{color:#ff7b8a;min-height:1.2em}
#cv{position:fixed;inset:0;width:100%;height:100%}
#hud{position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;display:flex;gap:8px;padding:8px;pointer-events:none;align-items:center}
#hud>*{pointer-events:auto}#code,#mn,#cell{background:#17141f;padding:4px 8px;border-radius:4px}#code{font:700 16px monospace;letter-spacing:.2em}#cell{font:12px monospace}
#hpb{width:120px;height:10px;background:#300;border-radius:5px;overflow:hidden}#hpf{height:100%;background:#d23a4c;width:100%}
#toast{position:fixed;top:56px;left:50%;transform:translateX(-50%);background:#000c;border:1px solid #8a1c2c;padding:8px 14px;border-radius:4px;max-width:80vw;text-align:center;opacity:0;transition:opacity .3s;pointer-events:none;z-index:9}
#wait{position:fixed;inset:0;background:#08070c;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;padding:20px;text-align:center;overflow:auto}
#atb div{display:flex;gap:8px;align-items:center;justify-content:center;margin:3px}#atb b{width:36px;text-align:left}
#sps{display:flex;gap:6px}#sps button{padding:4px}#sps img{width:48px;height:48px;display:block}
#dlg,#jr{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(120px + env(safe-area-inset-bottom,0));width:min(92vw,520px);background:#0d0a12f2;border:1px solid #8a1c2c;border-radius:6px;padding:12px;overflow:hidden}
#dlg p{font:italic 16px Georgia,serif;margin:8px 0}#dlg img{float:left;margin-right:10px;width:56px;height:56px}#jr{bottom:auto;top:56px;max-height:60vh;overflow:auto}
#mp{position:fixed;right:0;top:0;bottom:0;width:310px;background:#0d0a12f5;border-left:1px solid #3b3350;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px;padding-top:48px}
#mp label{display:block;font-size:12px;color:#a69fba;margin-top:4px}#mp label input:not([type=checkbox]),#mp label select{width:100%}
#tools,#tiles,#ses,.g{display:flex;flex-wrap:wrap;gap:5px}#tools button{flex:1;font-size:17px;padding:5px}
#tiles button{width:36px;height:36px;padding:0;background-size:cover}.g button{padding:2px}.g img{width:36px;height:36px;display:block}
.ac{border:1px solid #3b3350;border-radius:4px;padding:6px;margin-top:6px}.rm{float:right;padding:2px 8px}
#mform{border:1px solid #3b3350;border-radius:4px;padding:6px}
#mt{position:fixed;right:8px;top:calc(8px + env(safe-area-inset-top,0));z-index:5}
#touch{display:none}
@media(pointer:coarse){#touch:not([hidden]){display:block}}
#joy{position:fixed;left:24px;bottom:calc(24px + env(safe-area-inset-bottom,0));width:120px;height:120px;border-radius:50%;background:#ffffff14;border:1px solid #fff3;touch-action:none}
#knob{position:absolute;left:40px;top:40px;width:40px;height:40px;border-radius:50%;background:#d23a4ccc}
#bA,#bE{position:fixed;right:24px;width:68px;height:68px;border-radius:50%;font-size:26px;bottom:calc(24px + env(safe-area-inset-bottom,0))}#bE{right:104px;bottom:calc(44px + env(safe-area-inset-bottom,0));width:52px;height:52px}
@media(max-width:700px){#mp{top:auto;left:0;width:auto;max-height:50vh;border-left:0;border-top:1px solid #3b3350;padding-top:8px}#mp.c>*{display:none}}
</style></head><body>
<div id="home" class="screen"><h1>Engine Paranormal</h1><small>RPG de ação cooperativo com mestre e editor de campanha.</small>
<input id="nm" maxlength="16" placeholder="Seu nome"><button id="bc">Criar sala como mestre</button>
<small>ou entre numa sala existente</small><input id="cd" maxlength="4" placeholder="Código da sala" style="text-transform:uppercase"><button id="bj">Entrar na sala</button><div id="err"></div></div>
<div id="game" hidden><canvas id="cv"></canvas>
<div id="hud"><span id="code"></span><span id="mn"></span><div id="hpb"><div id="hpf"></div></div><span id="cell"></span><button id="bjr">📖</button></div>
<div id="toast"></div>
<div id="wait"><h1>Aguardando o mestre</h1><div>Sala <b id="code2"></b></div><div id="ros"></div><small>Escolha seu personagem:</small><div id="sps"></div><small>Distribua 10 pontos de atributo:</small><div id="atb"></div><small id="der"></small></div>
<div id="dlg" hidden></div><div id="jr" hidden></div>
<div id="touch" hidden><div id="joy"><i id="knob"></i></div><button id="bE">💬</button><button id="bA">⚔️</button></div>
<button id="mt" hidden>☰</button>
<div id="mp" hidden>
<div style="display:flex;gap:6px"><select id="maps" style="flex:1"></select><button id="bmg" title="Editar/criar mapas">⚙</button><button id="bst" title="Definir como mapa inicial">🏁</button></div>
<div id="mform" hidden><label>Nome<input id="mnm" maxlength="30"></label><div style="display:flex;gap:6px"><label>Largura<input id="mw" type="number" min="10" max="80"></label><label>Altura<input id="mh" type="number" min="10" max="60"></label></div>
<label>Cenário base (ao criar)<select id="mtpl"><option value="vazio">Campo aberto</option><option value="casa">Casa com cômodos</option><option value="floresta">Floresta com trilha</option><option value="cripta">Cripta com círculo ritual</option></select></label>
<div style="display:flex;gap:6px;margin-top:6px"><button id="mnew" style="flex:1">Criar novo mapa</button><button id="msave">Salvar</button><button id="mdel">Excluir</button></div></div>
<div id="tools"><button data-t="hand" title="Mover câmera">🖐</button><button data-t="sel" title="Selecionar/editar">✏️</button><button data-t="paint" title="Pincel">🖌</button><button data-t="fill" title="Balde">🪣</button><button data-t="rect" title="Retângulo">▭</button><button data-t="place" title="Colocar">➕</button><button data-t="del" title="Apagar">🗑</button></div>
<div id="tiles" hidden></div><div id="gal" hidden></div>
<div id="insp"></div>
<div id="ses"><button id="go" style="flex:1">▶ Iniciar sessão</button><button id="heal">✚ Curar</button></div>
<label>Dificuldade dos inimigos <input id="diff" type="range" min="0.5" max="3" step="0.25" value="1" style="width:100%"></label>
<div style="display:flex;gap:6px"><input id="say" placeholder="Mensagem para todos" style="flex:1"><button id="bsay">📣</button></div>
<div style="display:flex;gap:6px"><button id="exp" style="flex:1">💾 Exportar</button><button id="imp" style="flex:1">📂 Importar</button></div><input id="file" type="file" hidden>
<small id="ros2"></small></div></div>
<script src="/socket.io/socket.io.js"></script><script>
const $=i=>document.getElementById(i),TS=32;
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// ---------- sprites (pixel art em grade 16x16, desenhados por código) ----------
const SPR={},DU={};
function mk(id,n,cat,f){const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');
 f((a,b,w,h,col)=>{x.fillStyle=col;x.fillRect(a*2,b*2,w*2,h*2)});SPR[id]={n:n,cat:cat,img:c}}
const url=id=>DU[id]||(DU[id]=SPR[id]?SPR[id].img.toDataURL():'');
function hum(id,n,o){mk(id,n,o.cat||'Pessoas',R=>{
 R(5,12,2,3,o.pants);R(9,12,2,3,o.pants);R(4,15,3,1,'#111');R(9,15,3,1,'#111');
 R(4,7,8,5,o.shirt);R(3,8,1,4,o.shirt);R(12,8,1,4,o.shirt);R(3,12,1,1,o.skin);R(12,12,1,1,o.skin);
 if(o.robe){R(3,6,10,9,o.robe);R(5,15,6,1,o.robe)}
 R(5,2,6,5,o.skin);R(5,1,6,2,o.hair);if(o.long){R(4,2,1,5,o.hair);R(11,2,1,5,o.hair)}
 if(o.hood){R(4,1,8,7,o.hood);R(6,3,4,4,o.skin)}
 R(6,4,1,1,o.eye||'#111');R(9,4,1,1,o.eye||'#111');
 if(o.hat){R(4,1,8,2,o.hat);R(3,3,10,1,o.hat)}
 if(o.mask)R(6,5,4,2,o.mask);
 if(o.ribs){R(6,8,4,1,'#555');R(6,10,4,1,'#555')}})}
hum('investigador','Investigador',{skin:'#e0b08a',hair:'#4a3020',shirt:'#b08a5a',pants:'#3a3a50'});
hum('ocultista','Ocultista',{skin:'#d9b08c',hair:'#222',shirt:'#3a2a5a',pants:'#222',robe:'#3a2a5a',hood:'#3a2a5a'});
hum('soldado','Soldado',{skin:'#c99a74',hair:'#222',shirt:'#4a5a3a',pants:'#3a4530',hat:'#3a4530'});
hum('medica','Médica',{skin:'#f0c8a8',hair:'#b4501e',long:1,shirt:'#eee',pants:'#4a6a8a'});
hum('policial','Policial',{skin:'#a8704a',hair:'#111',shirt:'#2a3f6a',pants:'#1e2a44',hat:'#1e2a44'});
hum('aldeao','Sobrevivente',{skin:'#e0b08a',hair:'#8a7a50',shirt:'#6a5040',pants:'#4a4030'});
hum('padre','Padre',{skin:'#e8c4a0',hair:'#ccc',shirt:'#111',pants:'#111',robe:'#111'});
hum('cultista','Cultista',{skin:'#d9b08c',hair:'#222',shirt:'#7a1020',pants:'#222',robe:'#7a1020',hood:'#7a1020',mask:'#ddd',eye:'#f33',cat:'Criaturas'});
hum('zumbi','Zumbi',{skin:'#8fae6a',hair:'#2a2a1a',shirt:'#5a4a3a',pants:'#3a3a4a',eye:'#c22',cat:'Criaturas'});
hum('esqueleto','Esqueleto',{skin:'#e8e4d0',hair:'#e8e4d0',shirt:'#e8e4d0',pants:'#e8e4d0',eye:'#000',ribs:1,cat:'Criaturas'});
mk('sombra','Sombra','Criaturas',R=>{const k='#15101f';R(4,3,8,9,k);R(3,6,10,6,k);R(3,12,2,2,k);R(7,12,2,3,k);R(11,12,2,2,k);R(5,5,2,2,'#f22');R(9,5,2,2,'#f22')});
mk('criatura','Criatura','Criaturas',R=>{const k='#6a2a7a';R(3,5,10,8,k);R(4,3,8,3,k);R(2,13,2,2,k);R(6,13,2,3,k);R(10,13,2,3,k);R(13,11,1,4,k);R(5,5,2,2,'#ff0');R(9,5,2,2,'#ff0');R(7,8,2,2,'#ff0');R(5,11,6,1,'#200')});
mk('cao','Cão infernal','Criaturas',R=>{const k='#3a2a2a';R(2,7,10,4,k);R(10,5,4,4,k);R(13,6,2,2,'#222');R(11,6,1,1,'#f33');R(3,11,2,3,k);R(6,11,2,3,k);R(9,11,2,3,k);R(1,6,2,1,k);R(11,4,1,2,k)});
mk('olho','Olho flutuante','Criaturas',R=>{R(4,4,8,8,'#eee');R(3,5,10,6,'#eee');R(6,6,4,4,'#c22');R(7,7,2,2,'#000');R(4,5,1,1,'#c44');R(11,9,1,1,'#c44')});
mk('caixa','Caixote','Cenário',R=>{R(3,5,10,9,'#8a5a2a');R(3,5,10,1,'#a87a3a');R(3,9,10,1,'#6a4220');R(7,5,2,9,'#6a4220')});
mk('barril','Barril','Cenário',R=>{R(4,4,8,10,'#7a4a20');R(4,6,8,1,'#444');R(4,11,8,1,'#444');R(5,3,6,1,'#9a6a30')});
mk('bau','Baú','Cenário',R=>{R(2,7,12,7,'#7a4a20');R(2,5,12,3,'#8a5a2a');R(2,9,12,1,'#d4a020');R(7,8,2,3,'#d4a020')});
mk('mesa','Mesa','Cenário',R=>{R(2,6,12,3,'#8a5a2a');R(3,9,2,5,'#6a4220');R(11,9,2,5,'#6a4220')});
mk('cama','Cama','Cenário',R=>{R(2,5,12,9,'#6a4220');R(3,6,10,7,'#c8c8d8');R(3,6,4,3,'#fff');R(3,10,10,3,'#8a2030')});
mk('estante','Estante','Cenário',R=>{R(3,1,10,14,'#5a3a1a');[2,6,10].forEach(y=>{R(4,y,8,3,'#2a1a0a');R(4,y,1,3,'#a33');R(6,y,1,3,'#38a');R(8,y,1,3,'#3a3');R(10,y,2,3,'#aa3')})});
mk('arvore','Árvore','Cenário',R=>{R(7,9,2,6,'#5a3a1a');R(3,2,10,8,'#245a2a');R(2,4,12,4,'#2e7034');R(5,1,6,2,'#2e7034')});
mk('lapide','Lápide','Cenário',R=>{R(4,4,8,10,'#8a8a94');R(5,3,6,1,'#8a8a94');R(7,6,2,5,'#555');R(6,8,4,1,'#555');R(3,13,10,2,'#4a5a3a')});
mk('tocha','Tocha','Cenário',R=>{R(7,6,2,8,'#6a4220');R(6,2,4,5,'#f90');R(7,1,2,3,'#ff6')});
mk('altar','Altar','Cenário',R=>{R(2,7,12,7,'#4a4a56');R(3,5,10,3,'#6a6a78');R(6,3,4,2,'#c22');R(3,3,1,2,'#fe8');R(12,3,1,2,'#fe8')});
mk('papel','Bilhete','Pistas',R=>{R(4,3,8,10,'#e8e0c0');R(5,5,6,1,'#777');R(5,7,6,1,'#777');R(5,9,4,1,'#777')});
mk('diario','Diário','Pistas',R=>{R(3,3,10,10,'#4a2a2a');R(4,4,1,8,'#2a1010');R(6,6,5,1,'#caa');R(6,8,4,1,'#caa')});
mk('chave','Chave','Pistas',R=>{R(3,6,4,4,'#e8c040');R(4,7,2,2,'#4a3000');R(7,7,7,2,'#e8c040');R(11,9,1,2,'#e8c040');R(13,9,1,2,'#e8c040')});
mk('porta','Porta','Portas',R=>{R(4,1,8,14,'#6a4220');R(5,2,6,12,'#8a5a2a');R(9,8,1,2,'#d4a020');R(4,1,8,1,'#4a2a10')});
mk('escada','Escada','Portas',R=>{R(3,2,10,1,'#111');['#555','#666','#777','#888','#999'].forEach((c,i)=>R(3,3+i*2,10,2,c))});
mk('portal','Portal','Portas',R=>{R(4,2,8,12,'#7a2aaa');R(5,3,6,10,'#c070ff');R(7,5,2,6,'#fff')});
mk('runa','Gatilho (runa)','Eventos',R=>{const k='#d4c030';R(4,4,8,1,k);R(4,11,8,1,k);R(4,4,1,8,k);R(11,4,1,8,k);R(7,6,2,4,k)});
mk('alavanca','Alavanca','Eventos',R=>{R(4,11,8,3,'#555');R(7,5,2,7,'#aaa');R(6,3,4,3,'#d22')});
mk('bandeira','Início','Eventos',R=>{R(4,2,1,13,'#ddd');R(5,2,7,5,'#2a8a2a')});
const CATS={};Object.keys(SPR).forEach(k=>(CATS[SPR[k].cat]=CATS[SPR[k].cat]||[]).push(k));
const SOPT=Object.keys(CATS).map(c=>'<optgroup label="'+c+'">'+CATS[c].map(k=>'<option value="'+k+'">'+SPR[k].n+'</option>').join('')+'</optgroup>').join('');
const selOpt=(h,v)=>h.replace('value="'+v+'"','value="'+v+'" selected');
const OPT=(l,v)=>l.map(x=>'<option value="'+esc(x[0])+'"'+(String(x[0])===String(v)?' selected':'')+'>'+esc(x[1])+'</option>').join('');
const PS=['investigador','ocultista','soldado','medica','policial'];
// ---------- terrenos ----------
const TC=['#2f4a2c','#7a5a3a','#3a3640','#1d3b5c','#4a1218','#57575f','#6a4a2c','#050408'],TN=['Grama','Madeira','Parede','Água','Ritual','Concreto','Terra','Abismo'];
const TI=TC.map((col,t)=>{const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');x.fillStyle=col;x.fillRect(0,0,32,32);let s=t*97+1;const rn=()=>(s=s*16807%2147483647)/2147483647;
 const dots=(n,c2,z)=>{x.fillStyle=c2;for(let i=0;i<n;i++)x.fillRect(rn()*30|0,rn()*30|0,z,z)};
 if(t===0)dots(14,'#3a5a35',2);if(t===6)dots(16,'#7a5a3c',2);if(t===5){dots(10,'#4a4a52',2);x.fillStyle='#4a4a52';x.fillRect(0,31,32,1)}
 if(t===1){x.fillStyle='#00000033';for(let y=0;y<32;y+=8)x.fillRect(0,y,32,1);x.fillRect(10,0,1,8);x.fillRect(22,8,1,8);x.fillRect(6,16,1,8);x.fillRect(18,24,1,8)}
 if(t===2){x.fillStyle='#00000055';for(let y=0;y<32;y+=8){x.fillRect(0,y,32,1);for(let q=(y/8%2)*8;q<32;q+=16)x.fillRect(q,y,1,8)}x.fillStyle='#ffffff18';x.fillRect(0,0,32,3)}
 if(t===3){x.fillStyle='#2f5f8a';for(let i=0;i<5;i++)x.fillRect(rn()*24|0,rn()*30|0,8,1)}
 if(t===4){x.strokeStyle='#8a1a22';x.lineWidth=2;x.beginPath();x.arc(16,16,11,0,7);x.stroke();dots(5,'#8a1a22',3)}
 return c});
// ---------- estado ----------
const sock=io();
let me={},map=null,ps=[],os=[],fx=[],lib=[],MP=[],tool='hand',tile=2,pick=null,sel=null,jr=[],at={},mspr='investigador',cam={x:640,y:448},down=new Set(),jx=0,jy=0,last='',dl=null,Z=1,disp={},ro={names:[],playing:false},lc=-1,drag=null,rs=null,re=null;
$('nm').value=localStorage.pn||'';
sock.on('connect',()=>{const s=sessionStorage.po;if(s)sock.emit('room:rejoin',JSON.parse(s),ready)});
function ready(r){
 if(r.err){sessionStorage.removeItem('po');$('err').textContent=r.err;$('home').hidden=false;$('game').hidden=true;me={};return}
 me=r;sessionStorage.po=JSON.stringify({code:r.code,pid:r.pid});
 $('home').hidden=true;$('game').hidden=false;$('code').textContent=$('code2').textContent=r.code;
 const m=r.role==='m';$('mp').hidden=!m;$('mt').hidden=!m;layout();if(m){setTool('hand');insp()}}
function layout(){$('touch').hidden=!(map&&me.role==='p');$('wait').hidden=me.role==='m'||!!map;$('hpb').hidden=me.role!=='p'}
$('bc').onclick=()=>{localStorage.pn=$('nm').value;sock.emit('room:create',{},ready)};
$('bj').onclick=()=>{localStorage.pn=$('nm').value;sock.emit('room:join',{code:$('cd').value,name:$('nm').value},ready)};
$('mt').onclick=()=>$('mp').classList.toggle('c');
$('bjr').onclick=()=>{$('jr').hidden=!$('jr').hidden};
sock.on('map',m=>{map=m;$('mn').textContent=m.name;$('mnm').value=m.name;$('mw').value=m.w;$('mh').value=m.h;disp={};layout()});
sock.on('tiles',d=>{if(map&&map.id===d.id)d.c.forEach(t=>map.tiles[t[1]*map.w+t[0]]=t[2])});
sock.on('maps',d=>{MP=d.list;$('maps').innerHTML=OPT(d.list.map(m=>[m.id,m.name+(m.id===d.start?' 🏁':'')]),d.view)});
sock.on('tick',d=>{ps=d.ps;os=d.os;const m=ps.find(p=>p.id===me.pid);if(m)$('hpf').style.width=100*m.hp/m.maxhp+'%'});
sock.on('stop',()=>{map=null;os=[];ps=[];dl=null;$('dlg').hidden=true;layout()});
sock.on('lib',l=>{lib=l;gal()});
sock.on('roster',r=>{ro=r;const t=r.names.length?'Jogadores: '+r.names.join(', '):'Nenhum jogador ainda.';$('ros').textContent=$('ros2').textContent=t;$('go').textContent=r.playing?'■ Encerrar sessão':'▶ Iniciar sessão'});
sock.on('me',m=>{at=m.at;mspr=m.spr;showAt()});
sock.on('dialog',d=>{dl={d:d,i:0};showDl()});
sock.on('journal',j=>{jr=j;$('jr').innerHTML='<b>Diário de investigação</b>'+(j.length?j.map(x=>'<p><b>'+esc(x.t)+'</b><br>'+esc(x.x)+'</p>').join(''):'<p><small>Nenhuma pista descoberta.</small></p>')});
let tt;function toast(t){const e=$('toast');e.textContent=t;e.style.opacity=1;clearTimeout(tt);tt=setTimeout(()=>e.style.opacity=0,3500)}
sock.on('toast',toast);
sock.on('fx',f=>{f.t0=performance.now();fx.push(f)});
function showAt(){const sum=Object.keys(at).reduce((a,k)=>a+at[k],0);
 $('sps').innerHTML=PS.map(k=>'<button data-s="'+k+'"'+(k===mspr?' class="on"':'')+' title="'+SPR[k].n+'"><img src="'+url(k)+'"></button>').join('');
 $('atb').innerHTML=['FOR','AGI','INT','PRE','VIG'].map(k=>'<div><b>'+k+'</b><button data-a="'+k+'" data-d="-1">−</button> '+at[k]+' <button data-a="'+k+'" data-d="1">+</button></div>').join('')+'<small>Pontos restantes: '+(10-sum)+'</small>';
 $('der').textContent='Vida '+(12+at.VIG*4)+' · Dano '+(2+at.FOR*2)+' · Velocidade '+(90+at.AGI*14)+' · INT e PRE são narrativos por enquanto'}
$('sps').onclick=e=>{const b=e.target.closest('button');if(b)sock.emit('look',{spr:b.dataset.s})};
$('atb').onclick=e=>{const k=e.target.dataset.a;if(!k)return;const n=Object.assign({},at);n[k]+=+e.target.dataset.d;if(n[k]<0||n[k]>5||Object.keys(n).reduce((a,x)=>a+n[x],0)>10)return;sock.emit('attrs',n)};
function showDl(){if(!dl)return;$('dlg').hidden=false;$('dlg').innerHTML='<img src="'+url(dl.d.spr)+'"><b>'+esc(dl.d.name)+'</b><p>'+esc(dl.d.lines[dl.i])+'</p><button id="dn">'+(dl.i<dl.d.lines.length-1?'Próxima ▸':'Fechar')+'</button>';$('dn').onclick=nextDl}
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
(()=>{const j=$('joy'),k=$('knob');let id=null;
 const mv=e=>{const r=j.getBoundingClientRect();let dx=e.clientX-(r.left+60),dy=e.clientY-(r.top+60);const l=Math.hypot(dx,dy),m=48;if(l>m){dx*=m/l;dy*=m/l}
  jx=dx/m;jy=dy/m;k.style.transform='translate('+dx+'px,'+dy+'px)'};
 j.onpointerdown=e=>{id=e.pointerId;j.setPointerCapture(id);mv(e)};j.onpointermove=e=>{if(e.pointerId===id)mv(e)};
 j.onpointerup=j.onpointercancel=()=>{id=null;jx=jy=0;k.style.transform=''}})();
// ---------- editor de mapas ----------
function setTool(t){tool=t;document.querySelectorAll('#tools button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
 $('tiles').hidden=!['paint','fill','rect'].includes(t);$('gal').hidden=t!=='place';gal()}
$('tools').onclick=e=>{const b=e.target.closest('button');if(b)setTool(b.dataset.t)};
$('tiles').innerHTML=TI.map((c,i)=>'<button data-i="'+i+'" title="'+TN[i]+'" style="background-image:url('+c.toDataURL()+')"></button>').join('');
$('tiles').onclick=e=>{const b=e.target.closest('button');if(b){tile=+b.dataset.i;document.querySelectorAll('#tiles button').forEach(x=>x.classList.toggle('on',x===b))}};
const KL=[['enemy','Inimigos'],['npc','NPCs'],['prop','Cenário'],['clue','Pistas'],['door','Portas'],['event','Eventos'],['spawn','Início dos jogadores']];
function gal(){if(!lib.length)return;if(!lib.find(l=>l.id===pick))pick=lib[0].id;const pl=lib.find(l=>l.id===pick);
 $('gal').innerHTML='<b>'+esc(pl.name)+'</b>'+KL.map(g=>{const it=lib.filter(l=>l.kind===g[0]);return it.length?'<small>'+g[1]+'</small><div class="g">'+it.map(l=>'<button data-l="'+esc(l.id)+'" title="'+esc(l.name)+'"'+(l.id===pick?' class="on"':'')+'><img src="'+url(l.spr)+'"></button>').join('')+'</div>':''}).join('')}
$('gal').onclick=e=>{const b=e.target.closest('button');if(b){pick=b.dataset.l;gal()}};
$('maps').onchange=e=>{sel=null;insp();sock.emit('map:view',{id:e.target.value})};
$('bmg').onclick=()=>{$('mform').hidden=!$('mform').hidden};
$('bst').onclick=()=>sock.emit('map:start',{});
$('mnew').onclick=()=>sock.emit('map:new',{name:$('mnm').value,w:+$('mw').value,h:+$('mh').value,tpl:$('mtpl').value});
$('msave').onclick=()=>sock.emit('map:edit',{name:$('mnm').value,w:+$('mw').value,h:+$('mh').value});
$('mdel').onclick=()=>{if(confirm('Excluir este mapa e tudo o que há nele?'))sock.emit('map:del',{})};
const near=(p,r)=>{let b=null,bd=r;for(const o of os){const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<bd){bd=d;b=o}}return b};
const cellOf=p=>({x:Math.floor(p.x/TS),y:Math.floor(p.y/TS)});
function act(p){const c=cellOf(p);if(!map||c.x<0||c.y<0||c.x>=map.w||c.y>=map.h)return;
 if(tool==='paint'){const k=c.y*map.w+c.x;if(k===lc)return;lc=k;sock.emit('map:paint',{x:c.x,y:c.y,t:tile})}
 else if(tool==='fill')sock.emit('map:fill',{x:c.x,y:c.y,t:tile});
 else if(tool==='place'){const t=lib.find(l=>l.id===pick);if(!t)return;const o=JSON.parse(JSON.stringify(t));delete o.id;o.x=(c.x+.5)*TS;o.y=(c.y+.5)*TS;sock.emit('obj:put',{obj:o})}
 else if(tool==='del'){const o=near(p,22);if(o){sock.emit('obj:del',o.id);if(sel===o.id){sel=null;insp()}}}
 else if(tool==='sel'){const o=near(p,22);sel=o?o.id:null;insp()}}
const cv=$('cv'),wp=e=>({x:(e.clientX-innerWidth/2)/Z+cam.x,y:(e.clientY-innerHeight/2)/Z+cam.y});
cv.onpointerdown=e=>{if(!map)return;cv.setPointerCapture(e.pointerId);
 if(me.role==='p'){attack(Math.atan2(e.clientY-innerHeight/2,e.clientX-innerWidth/2));return}
 drag={x:e.clientX,y:e.clientY};lc=-1;const p=wp(e);if(tool==='rect'){rs=re=cellOf(p)}else act(p)};
cv.onpointermove=e=>{if(me.role!=='m'||!map)return;const p=wp(e),c=cellOf(p);$('cell').textContent='x'+c.x+' y'+c.y;if(!drag)return;
 if(tool==='hand'){cam.x-=(e.clientX-drag.x)/Z;cam.y-=(e.clientY-drag.y)/Z;drag.x=e.clientX;drag.y=e.clientY}else if(tool==='paint')act(p);else if(tool==='rect')re=c};
cv.onpointerup=()=>{if(tool==='rect'&&rs&&drag)sock.emit('map:rect',{x0:rs.x,y0:rs.y,x1:re.x,y1:re.y,t:tile});rs=re=null;drag=null};
// ---------- inspetor de objetos e editor de eventos ----------
const AN={say:'Mensagem na tela',dialog:'Diálogo',spawn:'Gerar inimigos (encontro)',tp:'Teleportar jogadores',show:'Mostrar/esconder objeto',lock:'Trancar/destrancar porta',heal:'Curar jogadores',hurt:'Causar dano',clue:'Adicionar pista ao diário'};
const F={say:[['text','Texto','t']],dialog:[['name','Quem fala','t'],['spr','Sprite','S'],['lines','Falas (uma por linha)','a']],spawn:[['lib','Inimigo','E'],['count','Quantidade','n']],
 tp:[['map','Mapa','M'],['x','X (célula, -1 = início)','n'],['y','Y (célula)','n']],show:[['target','Objeto','O'],['v','Ação','V']],lock:[['target','Porta','D'],['v','Ação','L']],heal:[],hurt:[['v','Dano','n']],clue:[['name','Título','t'],['text','Texto','A']]};
const AD={dialog:{lines:[]},spawn:{count:2,lib:'zumbi'},tp:{x:-1,y:-1},show:{v:true},lock:{v:false},hurt:{v:3}};
function acRow(a){return '<div class="ac" data-t="'+a.t+'"><button class="rm">✕</button><b>'+AN[a.t]+'</b>'+(F[a.t]||[]).map(f=>{const n=f[0],ty=f[2],v=a[n];let i;
 if(ty==='a'||ty==='A')i='<textarea data-f="'+n+'">'+esc(Array.isArray(v)?v.join('\n'):v)+'</textarea>';
 else if(ty==='n')i='<input data-f="'+n+'" type="number" value="'+(v==null?0:v)+'">';
 else if(ty==='t')i='<input data-f="'+n+'" value="'+esc(v)+'">';
 else{let h;if(ty==='S')h=selOpt(SOPT,v||'aldeao');else if(ty==='E')h=OPT(lib.filter(l=>l.kind==='enemy').map(l=>[l.id,l.name]),v);
  else if(ty==='M')h=OPT(MP.map(m=>[m.id,m.name]),v);else if(ty==='O')h=OPT(os.filter(o=>o.kind!=='spawn').map(o=>[o.id,o.name+' ('+o.kind+')']),v);
  else if(ty==='D')h=OPT(os.filter(o=>o.kind==='door').map(o=>[o.id,o.name]),v);else if(ty==='V')h=OPT([['1','Mostrar'],['0','Esconder']],v?'1':'0');else h=OPT([['1','Trancar'],['0','Destrancar']],v?'1':'0');
  i='<select data-f="'+n+'">'+h+'</select>'}
 return '<label>'+f[1]+i+'</label>'}).join('')+'</div>'}
function insp(){const el=$('insp'),o=os.find(x=>x.id===sel);
 if(!o){el.innerHTML='<small>Use ✏️ e toque num objeto, porta ou evento para editar.</small>';return}
 const k=o.kind,L=(n,l,t,v)=>'<label>'+l+(t==='a'?'<textarea data-k="'+n+'">'+esc(v)+'</textarea>':'<input data-k="'+n+'" type="'+(t==='c'?'checkbox':t==='n'?'number':'text')+'" '+(t==='c'?(v?'checked':''):'value="'+esc(v)+'"')+'>')+'</label>';
 let h='<b>'+esc(o.name||k)+'</b> <small>'+k+'</small>'+L('name','Nome','t',o.name)+'<label>Sprite<select data-k="spr">'+selOpt(SOPT,o.spr)+'</select></label>';
 if(k==='npc')h+=L('dialog','Falas (uma por linha)','a',(o.dialog||[]).join('\n'));
 if(k==='enemy')h+=L('hp','Vida','n',o.maxhp)+L('atk','Ataque','n',o.atk)+L('spd','Velocidade','n',o.spd);
 if(k==='prop')h+=L('solid','Bloqueia passagem','c',o.solid);
 if(k==='clue')h+=L('text','Informação (revelada ao examinar)','a',o.text);
 if(k==='door')h+='<label>Leva ao mapa<select data-k="to"><option value="">— nenhum —</option>'+OPT(MP.map(m=>[m.id,m.name]),o.to)+'</select></label>'+L('tx','Destino X (célula, -1 = início do mapa)','n',o.tx)+L('ty','Destino Y (célula)','n',o.ty)+L('group','Leva o grupo todo','c',o.group)+L('locked','Trancada','c',o.locked)+L('back','Criar porta de volta no destino','c',false);
 if(k==='event')h+='<label>Quando<select data-k="when">'+OPT([['enter','Jogador entra na área'],['interact','Jogador interage (E)'],['clear','Todos os inimigos do mapa morrem']],o.when)+'</select></label>'+L('r','Raio da área (px)','n',o.r)+L('once','Acontece uma vez só','c',o.once)+L('reset','Reativar agora','c',false)+'<b>Ações</b><div id="acs">'+(o.acts||[]).map(acRow).join('')+'</div><div style="display:flex;gap:6px;margin-top:6px"><select id="addt" style="flex:1">'+OPT(Object.keys(AN).map(t=>[t,AN[t]]),'say')+'</select><button id="addb">+ Ação</button></div>';
 if(k!=='spawn')h+=L('vis','Visível aos jogadores','c',!o.hidden);
 h+=L('note','Notas secretas (só o mestre vê)','a',o.note)+'<div style="display:flex;gap:6px;margin-top:6px"><button id="ap" style="flex:1">Aplicar</button><button id="sv" title="Guardar na biblioteca">Salvar modelo</button>'+(k==='door'?'<button id="gd">Ver destino</button>':'')+'</div>';
 el.innerHTML=h;
 if(k==='event'){$('addb').onclick=()=>{const t=$('addt').value;$('acs').insertAdjacentHTML('beforeend',acRow(Object.assign({t:t},AD[t]||{})))};$('acs').onclick=e=>{if(e.target.className==='rm')e.target.parentNode.remove()}}
 const get=()=>{const r={id:o.id};el.querySelectorAll('[data-k]').forEach(i=>{const n=i.dataset.k;let v=i.type==='checkbox'?i.checked:i.type==='number'?+i.value:i.value;
   if(n==='dialog')v=v.split(/\r?\n/);if(n==='vis')r.hidden=!v;else r[n]=v});
  if(k==='event')r.acts=[...el.querySelectorAll('.ac')].map(w=>{const a={t:w.dataset.t};w.querySelectorAll('[data-f]').forEach(i=>{const n=i.dataset.f,ty=(F[a.t].find(f=>f[0]===n)||[])[2];
    a[n]=ty==='n'?+i.value:ty==='a'?i.value.split(/\r?\n/):(ty==='V'||ty==='L')?i.value==='1':i.value});return a});return r};
 $('ap').onclick=()=>{sock.emit('obj:put',{obj:get()});toast('Aplicado')};
 $('sv').onclick=()=>{const r=get();r.kind=k;sock.emit('lib:save',{obj:r});toast('Modelo salvo na biblioteca (aba ➕)')};
 if(k==='door')$('gd').onclick=()=>{if(o.to){sel=null;sock.emit('map:view',{id:o.to});insp()}}}
$('go').onclick=()=>sock.emit(ro.playing?'game:stop':'game:start');
$('heal').onclick=()=>sock.emit('heal');
$('diff').onchange=e=>sock.emit('diff',+e.target.value);
$('bsay').onclick=()=>{sock.emit('say',$('say').value);$('say').value=''};
$('exp').onclick=()=>sock.emit('camp:export',j=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([j],{type:'application/json'}));a.download='campanha.json';a.click()});
$('imp').onclick=()=>$('file').click();
$('file').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>sock.emit('camp:import',r.result,x=>{toast(x.err||'Campanha importada');sel=null;insp()});r.readAsText(f);e.target.value=''};
// ---------- renderização ----------
function sm(id,x,y){const d=disp[id]||(disp[id]={x:x,y:y,f:1,mv:0});const dx=x-d.x,dy=y-d.y;if(Math.abs(dx)+Math.abs(dy)>120){d.x=x;d.y=y}else{d.x+=dx*.35;d.y+=dy*.35}d.mv=Math.hypot(dx,dy)>.8;if(Math.abs(dx)>.5)d.f=dx<0?-1:1;return d}
function bar(c,x,y,w,f,col){c.fillStyle='#000a';c.fillRect(x-w/2,y,w,4);c.fillStyle=col;c.fillRect(x-w/2,y,w*Math.max(0,f),4)}
function sprite(c,id,x,y,f,bob){const s=SPR[id]||SPR.caixa;c.save();c.translate(x,y+bob);if(f<0)c.scale(-1,1);c.drawImage(s.img,-16,-22);c.restore()}
function shadow(c,x,y){c.fillStyle='#0006';c.beginPath();c.ellipse(x,y+9,10,4,0,0,7);c.fill()}
function draw(){requestAnimationFrame(draw);if($('game').hidden)return;
 const w=cv.width=innerWidth,h=cv.height=innerHeight,c=cv.getContext('2d'),now=performance.now();c.imageSmoothingEnabled=false;c.fillStyle='#000';c.fillRect(0,0,w,h);if(!map)return;
 Z=Math.max(.9,Math.min(1.6,w/560));const M=me.role==='m',mine=ps.find(p=>p.id===me.pid);
 if(mine){const d=sm(mine.id,mine.x,mine.y);cam.x=d.x;cam.y=d.y}else if(M&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){cam.x+=ax(['d','arrowright'],['a','arrowleft'])*8;cam.y+=ax(['s','arrowdown'],['w','arrowup'])*8}
 c.save();c.translate(w/2,h/2);c.scale(Z,Z);c.translate(-cam.x,-cam.y);
 const x0=Math.max(0,Math.floor((cam.x-w/2/Z)/TS)),x1=Math.min(map.w-1,Math.ceil((cam.x+w/2/Z)/TS)),y0=Math.max(0,Math.floor((cam.y-h/2/Z)/TS)),y1=Math.min(map.h-1,Math.ceil((cam.y+h/2/Z)/TS));
 for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){c.drawImage(TI[map.tiles[y*map.w+x]],x*TS,y*TS);if(M){c.strokeStyle='#ffffff0d';c.strokeRect(x*TS,y*TS,TS,TS)}}
 if(rs&&re){const a=Math.min(rs.x,re.x),b=Math.min(rs.y,re.y),e=Math.abs(rs.x-re.x)+1,g=Math.abs(rs.y-re.y)+1;c.fillStyle='#ffffff33';c.fillRect(a*TS,b*TS,e*TS,g*TS)}
 c.textAlign='center';c.textBaseline='middle';
 const items=os.map(o=>({o:o,d:sm(o.id,o.x,o.y)})).sort((a,b)=>a.d.y-b.d.y);
 for(const it of items){const o=it.o,d=it.d,hid=o.hidden||o.kind==='spawn';c.globalAlpha=hid?.5:1;
  if(M&&o.kind==='event'&&o.when==='enter'){c.setLineDash([5,5]);c.strokeStyle='#ff6';c.beginPath();c.arc(d.x,d.y,o.r,0,7);c.stroke();c.setLineDash([])}
  const mover=o.kind==='enemy';if(mover||o.kind==='npc')shadow(c,d.x,d.y);
  sprite(c,o.spr,d.x,d.y,mover?d.f:1,mover&&d.mv?Math.sin(now/70)*1.5:0);c.globalAlpha=1;
  if(o.id===sel){c.strokeStyle='#fff';c.strokeRect(d.x-16,d.y-20,32,32)}
  if(o.kind==='enemy'&&(o.hp<o.maxhp||M))bar(c,d.x,d.y-24,28,o.hp/o.maxhp,'#d23a4c');
  if(['npc','enemy','door'].includes(o.kind)||(M&&o.kind!=='prop')){c.font='10px sans-serif';c.fillStyle='#fff';c.fillText(o.name,d.x,d.y+16)}}
 for(const p of ps){const d=disp[p.id]||sm(p.id,p.x,p.y);if(p.id!==me.pid)sm(p.id,p.x,p.y);
  if(p.dead){c.font='22px serif';c.fillText('💀',d.x,d.y);continue}
  shadow(c,d.x,d.y);c.strokeStyle=p.color;c.lineWidth=2;c.beginPath();c.ellipse(d.x,d.y+9,12,5,0,0,7);c.stroke();
  sprite(c,p.spr,d.x,d.y,d.f,d.mv?Math.sin(now/60)*1.5:0);
  bar(c,d.x,d.y-24,26,p.hp/p.maxhp,'#4c4');c.font='10px sans-serif';c.fillStyle='#fff';c.fillText(p.name,d.x,d.y+18)}
 fx=fx.filter(f=>now-f.t0<700);
 for(const f of fx){const a=(now-f.t0)/700;
  if(f.t==='slash'){c.strokeStyle='rgba(255,255,255,'+(1-a*1.5)+')';c.lineWidth=3;c.beginPath();c.arc(f.x,f.y,18,f.a-1,f.a+1);c.stroke()}
  else{c.globalAlpha=1-a;c.font='bold 16px sans-serif';c.fillStyle=f.c;c.fillText(f.v,f.x,f.y-14-a*24);c.globalAlpha=1}}
 c.restore();
 if(me.role==='p'){const g=c.createRadialGradient(w/2,h/2,Math.min(w,h)*.25,w/2,h/2,Math.max(w,h)*.7);g.addColorStop(0,'#0000');g.addColorStop(1,'#000c');c.fillStyle=g;c.fillRect(0,0,w,h)}}
draw();
</script></body></html>`; }
