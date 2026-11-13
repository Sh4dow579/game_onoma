const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const {
  LETTERS, CATEGORIES, CATEGORY_IDS, DEFAULT_CATEGORIES,
  isValid, scoreRound, pickLetter,
} = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_ROUNDS = LETTERS.length; // 24
const COLLECT_GRACE_MS = 1500;     // χρόνος για να φτάσουν οι τελευταίες απαντήσεις
const ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_PLAYERS = 20;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, any>} */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    letter: room.letter,
    usedLetters: room.usedLetters,
    remainingMs: room.state === 'playing' ? Math.max(0, room.endsAt - Date.now()) : 0,
    stoppedBy: room.stoppedBy,
    endReason: room.endReason,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      inRound: room.roundPlayers.includes(p.id),
    })),
    lastResults: room.lastResults,
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  io.to(room.code).emit('state', publicState(room));
}

function startRound(room) {
  const letter = pickLetter(room.usedLetters);
  if (!letter || room.round >= MAX_ROUNDS) return finishGame(room, 'allLetters');
  room.round += 1;
  room.letter = letter;
  room.usedLetters.push(letter);
  room.state = 'playing';
  room.stoppedBy = null;
  room.endReason = null;
  room.lastResults = null;
  room.answers = {};
  room.roundPlayers = connectedPlayers(room).map((p) => p.id);
  room.endsAt = Date.now() + room.settings.duration * 1000;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room, 'time'), room.settings.duration * 1000);
  broadcast(room);
}

function endRound(room, reason, stoppedBy = null) {
  if (room.state !== 'playing') return;
  clearTimeout(room.timer);
  room.state = 'collecting';
  room.endReason = reason;
  room.stoppedBy = stoppedBy;
  broadcast(room);
  io.to(room.code).emit('collect');
  room.timer = setTimeout(() => scoreAndShow(room), COLLECT_GRACE_MS);
}

function scoreAndShow(room) {
  if (room.state !== 'collecting') return;
  const cats = room.settings.categories;
  const { perAnswer, totals } = scoreRound(room.roundPlayers, room.answers, cats, room.letter);
  for (const pid of room.roundPlayers) {
    const p = room.players.get(pid);
    if (p) p.score += totals[pid];
  }
  room.lastResults = {
    round: room.round,
    letter: room.letter,
    categories: cats,
    players: room.roundPlayers.map((pid) => ({
      id: pid,
      name: room.players.get(pid)?.name || '?',
      answers: perAnswer[pid],
      total: totals[pid],
    })),
  };
  room.state = room.round >= MAX_ROUNDS ? 'finished' : 'results';
  if (room.state === 'finished') room.endReason = 'allLetters';
  broadcast(room);
}

function finishGame(room, reason = 'host') {
  clearTimeout(room.timer);
  room.state = 'finished';
  room.endReason = reason;
  broadcast(room);
}

function resetGame(room) {
  clearTimeout(room.timer);
  room.state = 'lobby';
  room.round = 0;
  room.letter = null;
  room.usedLetters = [];
  room.answers = {};
  room.roundPlayers = [];
  room.lastResults = null;
  room.stoppedBy = null;
  room.endReason = null;
  for (const p of room.players.values()) p.score = 0;
  // αφαιρούμε όσους έχουν φύγει
  for (const [pid, p] of room.players) if (!p.connected) room.players.delete(pid);
  broadcast(room);
}

function sanitizeAnswers(room, answers) {
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const cat of room.settings.categories) {
    const v = answers[cat];
    if (typeof v === 'string') out[cat] = v.slice(0, 40);
  }
  return out;
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  function attach(r, pid, name) {
    room = r;
    let p = r.players.get(pid);
    if (p) {
      p.connected = true;
      p.socketId = socket.id;
      if (name) p.name = name;
    } else {
      p = { id: pid, name, score: 0, connected: true, socketId: socket.id };
      r.players.set(pid, p);
    }
    me = p;
    socket.join(r.code);
    ensureHost(r);
    broadcast(r);
  }

  socket.on('createRoom', ({ name, pid } = {}, cb = () => {}) => {
    name = cleanName(name);
    if (!name) return cb({ error: 'Γράψε ένα όνομα.' });
    if (typeof pid !== 'string' || pid.length < 8) return cb({ error: 'Μη έγκυρο αναγνωριστικό.' });
    const code = makeCode();
    const r = {
      code,
      hostId: pid,
      players: new Map(),
      settings: { categories: [...DEFAULT_CATEGORIES], duration: 180 },
      state: 'lobby',
      round: 0,
      letter: null,
      usedLetters: [],
      answers: {},
      roundPlayers: [],
      lastResults: null,
      stoppedBy: null,
      endReason: null,
      endsAt: 0,
      timer: null,
      lastActivity: Date.now(),
    };
    rooms.set(code, r);
    attach(r, pid, name);
    cb({ code });
  });

  socket.on('joinRoom', ({ code, name, pid } = {}, cb = () => {}) => {
    code = String(code || '').toUpperCase().trim();
    name = cleanName(name);
    const r = rooms.get(code);
    if (!r) return cb({ error: 'Δεν βρέθηκε δωμάτιο με αυτόν τον κωδικό.' });
    if (typeof pid !== 'string' || pid.length < 8) return cb({ error: 'Μη έγκυρο αναγνωριστικό.' });
    const existing = r.players.get(pid);
    if (!existing) {
      if (!name) return cb({ error: 'Γράψε ένα όνομα.' });
      if (r.players.size >= MAX_PLAYERS) return cb({ error: 'Το δωμάτιο είναι γεμάτο.' });
    }
    attach(r, pid, name || existing.name);
    cb({ code, answers: r.answers[pid] || {} });
  });

  socket.on('updateSettings', ({ categories, duration } = {}) => {
    if (!room || room.hostId !== me.id || room.state !== 'lobby') return;
    if (Array.isArray(categories)) {
      const cats = CATEGORY_IDS.filter((c) => categories.includes(c));
      if (cats.length > 0) room.settings.categories = cats;
    }
    const d = Number(duration);
    if (Number.isFinite(d)) room.settings.duration = Math.min(300, Math.max(60, Math.round(d / 60) * 60));
    broadcast(room);
  });

  socket.on('startRound', () => {
    if (!room || room.hostId !== me.id) return;
    if (room.state !== 'lobby' && room.state !== 'results') return;
    startRound(room);
  });

  socket.on('answers', (answers) => {
    if (!room || !me) return;
    if (room.state !== 'playing' && room.state !== 'collecting') return;
    if (!room.roundPlayers.includes(me.id)) return;
    room.answers[me.id] = sanitizeAnswers(room, answers);
  });

  socket.on('stop', (answers, cb = () => {}) => {
    if (!room || !me || room.state !== 'playing') return cb({ error: 'Ο γύρος δεν είναι ενεργός.' });
    if (!room.roundPlayers.includes(me.id)) return cb({ error: 'Δεν συμμετέχεις σε αυτόν τον γύρο.' });
    const clean = sanitizeAnswers(room, answers);
    room.answers[me.id] = clean;
    const allFilled = room.settings.categories.every((c) => isValid(clean[c], room.letter));
    if (!allFilled) return cb({ error: `Συμπλήρωσε όλες τις κατηγορίες με λέξεις από «${room.letter}».` });
    cb({ ok: true });
    endRound(room, 'stop', me.id);
  });

  socket.on('endGame', () => {
    if (!room || room.hostId !== me.id) return;
    if (room.state === 'lobby' || room.state === 'finished') return;
    finishGame(room, 'host');
  });

  socket.on('newGame', () => {
    if (!room || room.hostId !== me.id || room.state !== 'finished') return;
    resetGame(room);
  });

  socket.on('leaveRoom', () => {
    if (!room || !me) return;
    socket.leave(room.code);
    if (room.state === 'lobby') room.players.delete(me.id);
    else me.connected = false;
    ensureHost(room);
    broadcast(room);
    room = null;
    me = null;
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    if (me.socketId !== socket.id) return; // έχει ήδη επανασυνδεθεί αλλού
    me.connected = false;
    ensureHost(room);
    broadcast(room);
  });
});

// Καθαρισμός άδειων/αδρανών δωματίων
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (connectedPlayers(r).length === 0 && now - r.lastActivity > 5 * 60 * 1000) {
      clearTimeout(r.timer);
      rooms.delete(code);
    } else if (now - r.lastActivity > ROOM_IDLE_MS && r.state !== 'playing') {
      clearTimeout(r.timer);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

app.get('/api/meta', (_req, res) => res.json({ categories: CATEGORIES, maxRounds: MAX_ROUNDS }));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Ο server τρέχει στο http://localhost:${PORT}`));
}

module.exports = { server, rooms };
