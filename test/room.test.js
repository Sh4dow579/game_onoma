import assert from 'node:assert';
import { scoreRound, normalize } from '../src/game.js';
import { Room, COLLECT_GRACE_MS } from '../src/room.js';

// ---------- Βαθμολόγηση ----------
assert.strictEqual(normalize('  Άρης '), 'αρησ');
{
  const { perAnswer: r } = scoreRound(['a', 'b', 'c'], {
    a: { name: 'Άννα' }, b: { name: 'αννα' }, c: { name: 'Αλέξης' },
  }, ['name'], 'Α');
  assert.deepStrictEqual([r.a.name.points, r.b.name.points, r.c.name.points], [5, 5, 10]);
}
{
  const { perAnswer: r } = scoreRound(['a', 'b', 'c', 'd'], {
    a: { name: 'Άννα' }, b: { name: 'Άννα' }, c: { name: 'Αλέξης' }, d: { name: '' },
  }, ['name'], 'Α');
  assert.deepStrictEqual([r.a.name.points, r.c.name.points, r.d.name.points], [10, 20, 0]);
}
{
  const { perAnswer: r } = scoreRound(['a', 'b'], {
    a: { animal: 'Αετός' }, b: { animal: 'Βόδι' },
  }, ['animal'], 'Α');
  assert.strictEqual(r.a.animal.points, 20);
  assert.strictEqual(r.b.animal.status, 'invalid');
}
console.log('✓ βαθμολόγηση');

// ---------- Ροή δωματίου ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(room) {
  const c = { last: null, acks: {}, n: 0 };
  c.conn = {
    send: (m) => {
      if (m.t === 'state') c.last = m.d;
      if (m.t === 'ack') c.acks[m.id] = m.d;
    },
  };
  c.do = (t, d) => { const id = ++c.n; room.handle(c.conn, { t, d, id }); return c.acks[id]; };
  return c;
}

const room = new Room('ABCD');
const [h, p1, p2] = [client(room), client(room), client(room)];

assert.ok(p1.do('joinRoom', { name: 'Π1', pid: 'p1-00000' }).error, 'join πριν τη δημιουργία');
assert.strictEqual(h.do('createRoom', { name: 'Host', pid: 'host-0000' }).code, 'ABCD');
assert.strictEqual(p2.do('createRoom', { name: 'X', pid: 'xxxx-0000' }).error, 'exists');
p1.do('joinRoom', { name: 'Π1', pid: 'p1-00000' });
p2.do('joinRoom', { name: 'Π2', pid: 'p2-00000' });

h.do('updateSettings', { categories: ['name', 'animal'], duration: 120 });
assert.deepStrictEqual(p1.last.settings, { categories: ['name', 'animal'], duration: 120 });

p1.do('startRound');
assert.strictEqual(p1.last.state, 'lobby', 'μόνο ο δημιουργός ξεκινά');

h.do('startRound');
assert.strictEqual(p1.last.state, 'playing');
const L = p1.last.letter;
h.do('answers', { name: `${L}ηστ`, animal: `${L}ζωο` });
p1.do('answers', { name: `${L}ηστ`, animal: '' });
assert.ok(p2.do('stop', { name: `${L}χχ`, animal: '' }).error, 'ΣΤΟΠ με κενά απορρίπτεται');
assert.ok(p2.do('stop', { name: `${L}μοναδ`, animal: `${L}ζωο` }).ok);
assert.strictEqual(h.last.state, 'collecting');

await wait(COLLECT_GRACE_MS + 100);
assert.strictEqual(h.last.state, 'results');
const score = Object.fromEntries(h.last.players.map((p) => [p.name, p.score]));
assert.deepStrictEqual(score, { Host: 15, 'Π1': 5, 'Π2': 20 });
console.log('✓ γύρος με ΣΤΟΠ & βαθμολογία:', score);

h.do('startRound');
assert.notStrictEqual(h.last.letter, L);
h.do('endGame');
assert.strictEqual(p2.last.state, 'finished');
h.do('newGame');
assert.strictEqual(p2.last.state, 'lobby');
assert.ok(p2.last.players.every((p) => p.score === 0));
console.log('✓ τερματισμός & νέο παιχνίδι');

room.disconnect(h.conn);
assert.strictEqual(p1.last.hostId, 'p1-00000');
console.log('✓ μεταβίβαση δημιουργού');
console.log('ΟΛΑ ΟΚ');
