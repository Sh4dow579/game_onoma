// Ένα δωμάτιο παιχνιδιού, ανεξάρτητο από το δίκτυο.
// Κάθε σύνδεση (conn) είναι ένα αντικείμενο με μέθοδο send(obj).
// Τα μηνύματα του client: { t: <τύπος>, d: <δεδομένα>, id?: <αριθμός για απάντηση> }
// Ο server στέλνει: { t: 'ack', id, d } | { t: 'state', d } | { t: 'collect' }

import {
  LETTERS, CATEGORY_IDS, DEFAULT_CATEGORIES, isValid, scoreRound, pickLetter,
} from './game.js';

export const MAX_ROUNDS = LETTERS.length; // 24
export const COLLECT_GRACE_MS = 1500;
const MAX_PLAYERS = 20;

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
const validPid = (pid) => typeof pid === 'string' && pid.length >= 8 && pid.length <= 64;

export class Room {
  constructor(code) {
    this.code = code;
    this.created = false;
    this.hostId = null;
    this.players = new Map();   // pid -> { id, name, score, connected, conn }
    this.conns = new Map();     // conn -> pid
    this.settings = { categories: [...DEFAULT_CATEGORIES], duration: 180 };
    this.state = 'lobby';
    this.round = 0;
    this.letter = null;
    this.usedLetters = [];
    this.answers = {};
    this.roundPlayers = [];
    this.lastResults = null;
    this.stoppedBy = null;
    this.endReason = null;
    this.endsAt = 0;
    this.timer = null;
  }

  // ---------- σύνδεση / αποσύνδεση ----------
  handle(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const reply = (d) => { if (msg.id != null) conn.send({ t: 'ack', id: msg.id, d }); };
    const pid = this.conns.get(conn);
    const me = pid ? this.players.get(pid) : null;
    const d = msg.d || {};
    const isHost = me && this.hostId === me.id;

    switch (msg.t) {
      case 'createRoom': {
        if (this.created) return reply({ error: 'exists' });
        const name = cleanName(d.name);
        if (!name) return reply({ error: 'Γράψε ένα όνομα.' });
        if (!validPid(d.pid)) return reply({ error: 'Μη έγκυρο αναγνωριστικό.' });
        this.created = true;
        this.hostId = d.pid;
        this.attach(conn, d.pid, name);
        return reply({ code: this.code });
      }
      case 'joinRoom': {
        if (!this.created) return reply({ error: 'Δεν βρέθηκε δωμάτιο με αυτόν τον κωδικό.' });
        if (!validPid(d.pid)) return reply({ error: 'Μη έγκυρο αναγνωριστικό.' });
        const existing = this.players.get(d.pid);
        const name = cleanName(d.name);
        if (!existing) {
          if (!name) return reply({ error: 'Γράψε ένα όνομα.' });
          if (this.players.size >= MAX_PLAYERS) return reply({ error: 'Το δωμάτιο είναι γεμάτο.' });
        }
        this.attach(conn, d.pid, name || existing.name);
        return reply({ code: this.code, answers: this.answers[d.pid] || {} });
      }
      case 'updateSettings': {
        if (!isHost || this.state !== 'lobby') return;
        if (Array.isArray(d.categories)) {
          const cats = CATEGORY_IDS.filter((c) => d.categories.includes(c));
          if (cats.length > 0) this.settings.categories = cats;
        }
        const dur = Number(d.duration);
        if (Number.isFinite(dur)) this.settings.duration = Math.min(300, Math.max(60, Math.round(dur / 60) * 60));
        return this.broadcast();
      }
      case 'startRound':
        if (!isHost || (this.state !== 'lobby' && this.state !== 'results')) return;
        return this.startRound();
      case 'answers':
        if (!me || (this.state !== 'playing' && this.state !== 'collecting')) return;
        if (!this.roundPlayers.includes(me.id)) return;
        this.answers[me.id] = this.sanitize(d);
        return;
      case 'stop': {
        if (!me || this.state !== 'playing') return reply({ error: 'Ο γύρος δεν είναι ενεργός.' });
        if (!this.roundPlayers.includes(me.id)) return reply({ error: 'Δεν συμμετέχεις σε αυτόν τον γύρο.' });
        const clean = this.sanitize(d);
        this.answers[me.id] = clean;
        const allFilled = this.settings.categories.every((c) => isValid(clean[c], this.letter));
        if (!allFilled) return reply({ error: `Συμπλήρωσε όλες τις κατηγορίες με λέξεις από «${this.letter}».` });
        reply({ ok: true });
        return this.endRound('stop', me.id);
      }
      case 'endGame':
        if (!isHost || this.state === 'lobby' || this.state === 'finished') return;
        return this.finishGame('host');
      case 'newGame':
        if (!isHost || this.state !== 'finished') return;
        return this.resetGame();
      case 'leaveRoom':
        if (!me) return;
        this.conns.delete(conn);
        if (this.state === 'lobby') this.players.delete(me.id);
        else { me.connected = false; me.conn = null; }
        this.ensureHost();
        return this.broadcast();
      default:
    }
  }

  attach(conn, pid, name) {
    let p = this.players.get(pid);
    if (p) {
      if (p.conn && p.conn !== conn) this.conns.delete(p.conn);
      p.connected = true;
      p.conn = conn;
      if (name) p.name = name;
    } else {
      p = { id: pid, name, score: 0, connected: true, conn };
      this.players.set(pid, p);
    }
    this.conns.set(conn, pid);
    this.ensureHost();
    this.broadcast();
  }

  disconnect(conn) {
    const pid = this.conns.get(conn);
    this.conns.delete(conn);
    const p = pid && this.players.get(pid);
    if (!p || p.conn !== conn) return;
    p.connected = false;
    p.conn = null;
    this.ensureHost();
    this.broadcast();
  }

  isEmpty() {
    return this.connected().length === 0;
  }

  // ---------- βοηθητικά ----------
  connected() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  ensureHost() {
    const host = this.players.get(this.hostId);
    if (host && host.connected) return;
    const next = this.connected()[0];
    if (next) this.hostId = next.id;
  }

  sanitize(answers) {
    const out = {};
    if (!answers || typeof answers !== 'object') return out;
    for (const cat of this.settings.categories) {
      const v = answers[cat];
      if (typeof v === 'string') out[cat] = v.slice(0, 40);
    }
    return out;
  }

  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      settings: this.settings,
      round: this.round,
      maxRounds: MAX_ROUNDS,
      letter: this.letter,
      usedLetters: this.usedLetters,
      remainingMs: this.state === 'playing' ? Math.max(0, this.endsAt - Date.now()) : 0,
      stoppedBy: this.stoppedBy,
      endReason: this.endReason,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, score: p.score, connected: p.connected,
        inRound: this.roundPlayers.includes(p.id),
      })),
      lastResults: this.lastResults,
    };
  }

  broadcast() {
    const msg = { t: 'state', d: this.publicState() };
    for (const p of this.players.values()) if (p.conn) p.conn.send(msg);
  }

  // ---------- ροή παιχνιδιού ----------
  startRound() {
    const letter = pickLetter(this.usedLetters);
    if (!letter || this.round >= MAX_ROUNDS) return this.finishGame('allLetters');
    this.round += 1;
    this.letter = letter;
    this.usedLetters.push(letter);
    this.state = 'playing';
    this.stoppedBy = null;
    this.endReason = null;
    this.lastResults = null;
    this.answers = {};
    this.roundPlayers = this.connected().map((p) => p.id);
    const ms = this.settings.duration * 1000;
    this.endsAt = Date.now() + ms;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.endRound('time'), ms);
    this.broadcast();
  }

  endRound(reason, stoppedBy = null) {
    if (this.state !== 'playing') return;
    clearTimeout(this.timer);
    this.state = 'collecting';
    this.endReason = reason;
    this.stoppedBy = stoppedBy;
    this.broadcast();
    for (const p of this.players.values()) if (p.conn) p.conn.send({ t: 'collect' });
    this.timer = setTimeout(() => this.scoreAndShow(), COLLECT_GRACE_MS);
  }

  scoreAndShow() {
    if (this.state !== 'collecting') return;
    const cats = this.settings.categories;
    const { perAnswer, totals } = scoreRound(this.roundPlayers, this.answers, cats, this.letter);
    for (const pid of this.roundPlayers) {
      const p = this.players.get(pid);
      if (p) p.score += totals[pid];
    }
    this.lastResults = {
      round: this.round,
      letter: this.letter,
      categories: cats,
      players: this.roundPlayers.map((pid) => ({
        id: pid,
        name: this.players.get(pid)?.name || '?',
        answers: perAnswer[pid],
        total: totals[pid],
      })),
    };
    if (this.round >= MAX_ROUNDS) {
      this.state = 'finished';
      this.endReason = 'allLetters';
    } else {
      this.state = 'results';
    }
    this.broadcast();
  }

  finishGame(reason) {
    clearTimeout(this.timer);
    this.state = 'finished';
    this.endReason = reason;
    this.broadcast();
  }

  resetGame() {
    clearTimeout(this.timer);
    this.state = 'lobby';
    this.round = 0;
    this.letter = null;
    this.usedLetters = [];
    this.answers = {};
    this.roundPlayers = [];
    this.lastResults = null;
    this.stoppedBy = null;
    this.endReason = null;
    for (const [pid, p] of this.players) {
      if (!p.connected) this.players.delete(pid);
      else p.score = 0;
    }
    this.broadcast();
  }
}
