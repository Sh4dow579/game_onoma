/* global io */
(() => {
  const CATEGORIES = [
    { id: 'name', label: 'Όνομα' },
    { id: 'animal', label: 'Ζώο' },
    { id: 'plant', label: 'Φυτό' },
    { id: 'thing', label: 'Πράγμα' },
    { id: 'country', label: 'Χώρα' },
    { id: 'job', label: 'Επάγγελμα' },
    { id: 'food', label: 'Φαγητό' },
  ];
  const catLabel = (id) => (CATEGORIES.find((c) => c.id === id) || {}).label || id;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function normalize(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLocaleLowerCase('el').replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim();
  }
  const isValid = (a, letter) => { const n = normalize(a); return n.length > 0 && n.startsWith(normalize(letter)); };

  // ---- ταυτότητα παίκτη (επιβιώνει σε refresh) ----
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  let pid = store.get('ozfp.pid');
  if (!pid) {
    pid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set('ozfp.pid', pid);
  }
  $('nameInput').value = store.get('ozfp.name') || '';

  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();

  let roomCode = store.get('ozfp.room');
  let state = null;
  let renderedRound = 0;
  let localAnswers = {};
  let endAt = 0;
  let tick = null;

  const socket = io();

  socket.on('connect', () => {
    // επανασύνδεση σε δωμάτιο μετά από refresh ή διακοπή δικτύου
    if (roomCode) {
      socket.emit('joinRoom', { code: roomCode, pid }, (res) => {
        if (res.error) { leaveLocal(); return; }
        // ξαναγεμίζουμε τα πεδία με ό,τι είχε ήδη σταλεί στον server
        if (res.answers) {
          $('answerFields').querySelectorAll('input').forEach((i) => {
            if (!i.value && res.answers[i.dataset.cat]) i.value = res.answers[i.dataset.cat];
          });
          updateFieldStatus();
        }
      });
    }
  });

  socket.on('state', (s) => { state = s; render(); });
  socket.on('collect', () => socket.emit('answers', collectAnswers()));
  socket.on('disconnect', () => toast('Χάθηκε η σύνδεση… προσπαθούμε ξανά'));

  // ---- Αρχική ----
  function getName() {
    const n = $('nameInput').value.trim();
    if (!n) { $('homeError').textContent = 'Γράψε πρώτα το όνομά σου.'; $('nameInput').focus(); return null; }
    store.set('ozfp.name', n);
    return n;
  }
  $('createBtn').onclick = () => {
    const name = getName(); if (!name) return;
    socket.emit('createRoom', { name, pid }, (res) => {
      if (res.error) { $('homeError').textContent = res.error; return; }
      enterRoom(res.code);
    });
  };
  function join() {
    const name = getName(); if (!name) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length !== 4) { $('homeError').textContent = 'Ο κωδικός έχει 4 χαρακτήρες.'; return; }
    socket.emit('joinRoom', { code, name, pid }, (res) => {
      if (res.error) { $('homeError').textContent = res.error; return; }
      enterRoom(res.code);
    });
  }
  $('joinBtn').onclick = join;
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('codeInput').value.trim() ? join() : $('createBtn').click());
  });

  function enterRoom(code) {
    roomCode = code;
    store.set('ozfp.room', code);
    history.replaceState(null, '', `?room=${code}`);
    $('homeError').textContent = '';
  }
  function leaveLocal() {
    roomCode = null; state = null; renderedRound = 0; localAnswers = {};
    store.del('ozfp.room');
    history.replaceState(null, '', location.pathname);
    render();
  }
  const leave = () => { socket.emit('leaveRoom'); leaveLocal(); };
  $('leaveBtn').onclick = leave;
  $('leaveBtn2').onclick = leave;

  // ---- Lobby ----
  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText($('shareLink').value); toast('Αντιγράφηκε!'); }
    catch { $('shareLink').select(); }
  };
  $('catChecks').innerHTML = CATEGORIES.map((c) =>
    `<label><input type="checkbox" value="${c.id}"> ${c.label}</label>`).join('');
  $('catChecks').addEventListener('change', (e) => {
    const checked = [...$('catChecks').querySelectorAll('input:checked')].map((i) => i.value);
    if (checked.length === 0) { e.target.checked = true; toast('Χρειάζεται τουλάχιστον μία κατηγορία.'); return; }
    socket.emit('updateSettings', { categories: checked });
  });
  $('durRange').addEventListener('input', () => { $('durLabel').textContent = durText($('durRange').value * 60); });
  $('durRange').addEventListener('change', () => socket.emit('updateSettings', { duration: $('durRange').value * 60 }));
  $('startBtn').onclick = () => socket.emit('startRound');
  $('nextBtn').onclick = () => socket.emit('startRound');
  const confirmEnd = () => { if (confirm('Να τερματιστεί όλο το παιχνίδι;')) socket.emit('endGame'); };
  $('endGameBtn').onclick = confirmEnd;
  $('endGameBtnPlay').onclick = confirmEnd;
  $('newGameBtn').onclick = () => socket.emit('newGame');

  const durText = (sec) => `${sec / 60} ${sec === 60 ? 'λεπτό' : 'λεπτά'}`;

  // ---- Γύρος ----
  function collectAnswers() {
    const out = {};
    $('answerFields').querySelectorAll('input').forEach((i) => { out[i.dataset.cat] = i.value; });
    localAnswers = out;
    return out;
  }
  let sendTimer = null;
  $('answerFields').addEventListener('input', () => {
    updateFieldStatus();
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => socket.emit('answers', collectAnswers()), 300);
  });
  function updateFieldStatus() {
    if (!state) return;
    let all = true;
    $('answerFields').querySelectorAll('input').forEach((i) => {
      const v = i.value.trim();
      const ok = isValid(v, state.letter);
      i.classList.toggle('ok', ok);
      i.classList.toggle('bad', v.length > 0 && !ok);
      if (!ok) all = false;
    });
    $('stopBtn').disabled = !all || state.state !== 'playing';
  }
  $('answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('playError').textContent = '';
    socket.emit('stop', collectAnswers(), (res) => {
      if (res && res.error) $('playError').textContent = res.error;
    });
  });
  // Enter σε πεδίο -> επόμενο πεδίο (όχι ΣΤΟΠ κατά λάθος)
  $('answerFields').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...$('answerFields').querySelectorAll('input')];
    const next = inputs[inputs.indexOf(e.target) + 1];
    if (next) next.focus();
  });

  function buildFields() {
    $('answerFields').innerHTML = state.settings.categories.map((c) => `
      <div class="field"><label>${catLabel(c)}
        <input data-cat="${c}" maxlength="40" autocomplete="off" autocapitalize="sentences" spellcheck="false"
               placeholder="${esc(state.letter)}…">
      </label></div>`).join('');
    renderedRound = state.round;
    const first = $('answerFields').querySelector('input');
    if (first && !first.value) first.focus();
  }

  function startTicker() {
    clearInterval(tick);
    const draw = () => {
      const ms = Math.max(0, endAt - Date.now());
      const s = Math.ceil(ms / 1000);
      $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      $('timer').classList.toggle('low', s <= 15);
      if (ms <= 0) clearInterval(tick);
    };
    draw();
    tick = setInterval(draw, 250);
  }

  // ---- Render ----
  function show(screen) {
    ['home', 'lobby', 'play', 'results'].forEach((s) => $(`screen-${s}`).classList.toggle('hidden', s !== screen));
  }

  function render() {
    if (!state || !roomCode) {
      show('home');
      $('roomBadge').classList.add('hidden');
      clearInterval(tick);
      return;
    }
    const isHost = state.hostId === pid;
    const meP = state.players.find((p) => p.id === pid);
    $('roomBadge').textContent = state.code;
    $('roomBadge').classList.remove('hidden');

    if (state.state === 'lobby') {
      show('lobby');
      renderLobby(isHost);
    } else if (state.state === 'playing' || state.state === 'collecting') {
      show('play');
      renderPlay(isHost, meP);
    } else {
      show('results');
      renderResults(isHost);
    }
  }

  function playerList(el) {
    el.innerHTML = state.players.map((p) => `
      <li class="${p.connected ? '' : 'offline'}">
        <span>${esc(p.name)}</span>
        ${p.id === state.hostId ? '<span class="tag">δημιουργός</span>' : ''}
        ${p.id === pid ? '<span class="tag">εσύ</span>' : ''}
        ${p.connected ? '' : '<span class="tag">εκτός</span>'}
      </li>`).join('');
  }

  function renderLobby(isHost) {
    $('lobbyCode').textContent = state.code;
    $('shareLink').value = `${location.origin}${location.pathname}?room=${state.code}`;
    playerList($('lobbyPlayers'));
    $('settingsHost').classList.toggle('hidden', !isHost);
    $('settingsGuest').classList.toggle('hidden', isHost);
    const cats = state.settings.categories;
    $('catChecks').querySelectorAll('input').forEach((i) => { i.checked = cats.includes(i.value); });
    if (document.activeElement !== $('durRange')) $('durRange').value = state.settings.duration / 60;
    $('durLabel').textContent = durText(state.settings.duration);
    $('durLabelGuest').textContent = durText(state.settings.duration);
    $('catList').textContent = cats.map(catLabel).join(', ');
  }

  function renderPlay(isHost, meP) {
    $('roundNo').textContent = state.round;
    $('roundMax').textContent = state.maxRounds;
    $('letter').textContent = state.letter;
    $('hostbarPlay').classList.toggle('hidden', !isHost);
    const inRound = meP && meP.inRound;
    $('spectator').classList.toggle('hidden', !!inRound);

    if (state.state === 'playing') {
      $('collecting').classList.add('hidden');
      $('answerForm').classList.toggle('hidden', !inRound);
      if (inRound && renderedRound !== state.round) buildFields();
      endAt = Date.now() + state.remainingMs;
      startTicker();
      updateFieldStatus();
    } else {
      clearInterval(tick);
      $('timer').textContent = '0:00';
      $('answerForm').classList.add('hidden');
      $('collecting').classList.remove('hidden');
      const who = state.players.find((p) => p.id === state.stoppedBy);
      $('collectMsg').textContent = state.endReason === 'stop'
        ? `ΣΤΟΠ από ${who ? who.name : '?'}!` : 'Τέλος χρόνου!';
    }
  }

  function renderResults(isHost) {
    clearInterval(tick);
    renderedRound = 0;
    const finished = state.state === 'finished';
    const r = state.lastResults;

    if (finished) {
      const sorted = [...state.players].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      $('resultsTitle').textContent = 'Τέλος παιχνιδιού!';
      $('resultsSub').textContent = top ? `Νικητής: ${top.name} με ${top.score} πόντους` : '';
    } else {
      $('resultsTitle').textContent = r ? `Γύρος ${r.round} — Γράμμα ${r.letter}` : 'Αποτελέσματα';
      const who = state.players.find((p) => p.id === state.stoppedBy);
      $('resultsSub').textContent = state.endReason === 'stop'
        ? `Ο γύρος σταμάτησε με ΣΤΟΠ από ${who ? who.name : '?'}.` : 'Ο χρόνος τελείωσε.';
    }

    if (r) {
      $('resultsTable').parentElement.parentElement.querySelector('.legend').classList.remove('hidden');
      const head = `<tr><th>Παίκτης</th>${r.categories.map((c) => `<th>${catLabel(c)}</th>`).join('')}<th>Σύνολο</th></tr>`;
      const rows = [...r.players].sort((a, b) => b.total - a.total).map((p) => `<tr>
        <td><strong>${esc(p.name)}</strong></td>
        ${r.categories.map((c) => {
          const a = p.answers[c] || { text: '', points: 0, status: 'empty' };
          return `<td class="ans ${a.status}">${a.text ? esc(a.text) : '—'}<span class="pts">+${a.points}</span></td>`;
        }).join('')}
        <td class="total">${p.total}</td></tr>`).join('');
      $('resultsTable').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
    } else {
      $('resultsTable').innerHTML = '';
      $('resultsTable').parentElement.parentElement.querySelector('.legend').classList.add('hidden');
    }

    $('boardTitle').textContent = finished ? 'Τελική βαθμολογία' : `Βαθμολογία (μετά από ${state.round} ${state.round === 1 ? 'γύρο' : 'γύρους'})`;
    $('scoreboard').innerHTML = [...state.players].sort((a, b) => b.score - a.score).map((p) =>
      `<li class="${p.connected ? '' : 'offline'}"><span>${esc(p.name)}${p.id === pid ? ' (εσύ)' : ''}</span><strong>${p.score}</strong></li>`).join('');

    const canNext = !finished && state.round < state.maxRounds;
    $('hostbarResults').classList.toggle('hidden', !isHost);
    $('nextBtn').classList.toggle('hidden', !canNext);
    $('nextBtn').textContent = `Επόμενος γύρος (${state.round + 1}/${state.maxRounds})`;
    $('endGameBtn').classList.toggle('hidden', finished);
    $('newGameBtn').classList.toggle('hidden', !finished);
    $('waitHost').classList.toggle('hidden', isHost);
  }

  let toastTimer = null;
  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2200);
  }

  render();
})();
