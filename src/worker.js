// Cloudflare Worker: σερβίρει τη σελίδα (public/) και στέλνει κάθε
// WebSocket /ws/<ΚΩΔΙΚΟΣ> στο Durable Object του αντίστοιχου δωματίου.

import { Room } from './room.js';

const CODE_RE = /^[A-Z0-9]{4}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4})$/);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const code = m[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.room = null;
  }

  async fetch(request) {
    const code = new URL(request.url).pathname.split('/').pop().toUpperCase();
    if (!CODE_RE.test(code)) return new Response('Bad code', { status: 400 });
    if (!this.room) this.room = new Room(code);

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const conn = {
      send: (obj) => {
        try { server.send(JSON.stringify(obj)); } catch { /* η σύνδεση έκλεισε */ }
      },
    };

    server.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.t === 'ping') return conn.send({ t: 'pong' });
      this.room.handle(conn, msg);
    });
    const close = () => this.room.disconnect(conn);
    server.addEventListener('close', close);
    server.addEventListener('error', close);

    return new Response(null, { status: 101, webSocket: client });
  }
}
