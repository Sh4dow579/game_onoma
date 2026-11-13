const assert = require('assert');
const { io: ioc } = require('socket.io-client');
const { scoreRound, normalize } = require('../game');
const { server } = require('../server');

// ---------- Βαθμολόγηση ----------
assert.strictEqual(normalize('  Άρης '), 'αρησ');
{
  // Κανείς δεν αφήνει κενό: μοναδική 10, κοινή 5
  const { perAnswer: r } = scoreRound(['a', 'b', 'c'], {
    a: { name: 'Άννα' }, b: { name: 'αννα' }, c: { name: 'Αλέξης' },
  }, ['name'], 'Α');
  assert.strictEqual(r.a.name.points, 5);
  assert.strictEqual(r.b.name.points, 5);
  assert.strictEqual(r.c.name.points, 10);
}
{
  // Κάποιος αφήνει κενό: μοναδική 20, κοινή 10, κενό 0
  const { perAnswer: r } = scoreRound(['a', 'b', 'c', 'd'], {
    a: { name: 'Άννα' }, b: { name: 'Άννα' }, c: { name: 'Αλέξης' }, d: { name: '' },
  }, ['name'], 'Α');
  assert.strictEqual(r.a.name.points, 10);
  assert.strictEqual(r.c.name.points, 20);
  assert.strictEqual(r.d.name.points, 0);
}
{
  // Λάθος αρχικό γράμμα = 0 και μετράει ως κενό για τους άλλους
  const { perAnswer: r } = scoreRound(['a', 'b'], {
    a: { animal: 'Αετός' }, b: { animal: 'Βόδι' },
  }, ['animal'], 'Α');
  assert.strictEqual(r.a.animal.points, 20);
  assert.strictEqual(r.b.animal.points, 0);
  assert.strictEqual(r.b.animal.status, 'invalid');
}
console.log('✓ βαθμολόγηση');

// ---------- Ροή δωματίου ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

server.listen(0, async () => {
  const url = `http://localhost:${server.address().port}`;
  const mk = () => ioc(url, { forceNew: true });
  const [h, p1, p2] = [mk(), mk(), mk()];
  const last = new Map();
  for (const s of [h, p1, p2]) s.on('state', (st) => last.set(s, st));
  try {
    const { code } = await emit(h, 'createRoom', { name: 'Host', pid: 'host-0000' });
    assert.ok(code);
    await emit(p1, 'joinRoom', { code, name: 'Π1', pid: 'p1-00000' });
    await emit(p2, 'joinRoom', { code, name: 'Π2', pid: 'p2-00000' });
    h.emit('updateSettings', { categories: ['name', 'animal'], duration: 120 });
    await wait(100);
    assert.deepStrictEqual(last.get(p1).settings, { categories: ['name', 'animal'], duration: 120 });

    // μη-δημιουργός δεν μπορεί να ξεκινήσει
    p1.emit('startRound'); await wait(100);
    assert.strictEqual(last.get(p1).state, 'lobby');

    h.emit('startRound'); await wait(100);
    const st = last.get(p1);
    assert.strictEqual(st.state, 'playing');
    const L = st.letter;
    const w = (s) => `${L}${s}`;

    h.emit('answers', { name: w('ηστ'), animal: w('ζωο') });
    p1.emit('answers', { name: w('ηστ'), animal: '' });
    // ΣΤΟΠ με ελλιπείς απαντήσεις απορρίπτεται
    const bad = await emit(p2, 'stop', { name: w('χχ'), animal: '' });
    assert.ok(bad.error);
    const ok = await emit(p2, 'stop', { name: w('μοναδ'), animal: w('ζωο') });
    assert.ok(ok.ok);
    await wait(1800);
    const res = last.get(h);
    assert.strictEqual(res.state, 'results');
    const score = Object.fromEntries(res.players.map((p) => [p.name, p.score]));
    // name: Host=5, Π1=5, Π2=10 (κανείς κενός). animal: Π1 κενό -> Host & Π2 κοινή με κενό = 10 ο καθένας
    assert.deepStrictEqual(score, { Host: 15, 'Π1': 5, 'Π2': 20 });
    console.log('✓ γύρος με ΣΤΟΠ & βαθμολογία:', score);

    // δεύτερος γύρος, άλλο γράμμα, μετά τερματισμός από δημιουργό
    h.emit('startRound'); await wait(100);
    assert.notStrictEqual(last.get(h).letter, L);
    h.emit('endGame'); await wait(100);
    assert.strictEqual(last.get(p2).state, 'finished');
    h.emit('newGame'); await wait(100);
    assert.strictEqual(last.get(p2).state, 'lobby');
    assert.ok(last.get(p2).players.every((p) => p.score === 0));
    console.log('✓ τερματισμός & νέο παιχνίδι');

    // ο δημιουργός φεύγει -> νέος δημιουργός
    h.disconnect(); await wait(150);
    assert.strictEqual(last.get(p1).hostId, 'p1-00000');
    console.log('✓ μεταβίβαση δημιουργού');
    console.log('ΟΛΑ ΟΚ');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    for (const s of [h, p1, p2]) s.close();
    server.close();
    setTimeout(() => process.exit(), 100);
  }
});
