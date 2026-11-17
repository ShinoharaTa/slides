// スライドを別端末から操作するための WebSocket 中継。
// Worker はルーティング・Origin 検査・CORS だけを持ち、状態は Room（Durable Object）に置く。
import { DurableObject } from "cloudflare:workers";

const PROTOCOL = "slides-relay.v1";
const MAX_DEVICES = 4;
const MAX_PAIR_CODES = 4;
const MAX_MESSAGE_BYTES = 2048;
const RATE_LIMIT_PER_SEC = 20;

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const PAGES_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)?bluesky-meetup-slide2026\.pages\.dev$/;
const LOCAL_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

// role ごとに送ってよい type
const ALLOWED_TYPES = {
  control: new Set(["hello", "key", "pvw", "take", "reload"]),
  program: new Set(["state", "tally", "stale"]),
};
const NAMED_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ",
  "PageUp", "PageDown", "Home", "End",
]);
const BLOCKED_KEYS = new Set(["f", "p", "s"]);

// 16 バイトの乱数を base64url（パディングなし）にする
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (PAGES_ORIGIN_RE.test(origin) || LOCAL_ORIGIN_RE.test(origin)) return true;
  const extra = String(env.EXTRA_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

function withCors(res, origin) {
  // 101（WebSocket）の応答はヘッダを触らずにそのまま返す
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.append("Vary", "Origin");
  return out;
}

function isAllowedKey(key) {
  if (typeof key !== "string") return false;
  if (NAMED_KEYS.has(key)) return true;
  return /^[0-9a-z]$/.test(key) && !BLOCKED_KEYS.has(key);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin, env)) {
      return new Response("forbidden origin", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        },
      });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // POST /rooms
    if (parts.length === 1 && parts[0] === "rooms") {
      if (request.method !== "POST") return withCors(json({ error: "method not allowed" }, 405), origin);
      const room = randomId();
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      const res = await stub.fetch(`https://room/rooms/${room}/init`, { method: "POST" });
      return withCors(res, origin);
    }

    // /rooms/:room/...
    if (parts[0] === "rooms" && parts.length >= 2 && parts.length <= 3) {
      const room = parts[1];
      if (!ID_RE.test(room)) return withCors(json({ error: "not found" }, 404), origin);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return withCors(await stub.fetch(request), origin);
    }

    return withCors(json({ error: "not found" }, 404), origin);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 1 秒の固定窓のカウンタ。ハイバネーションで消えてもよい
    this.rates = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const action = parts[2] || "";
    const method = request.method;

    if (action === "init" && method === "POST") return this.init(parts[1]);

    const state = await this.loadState();
    if (state.status !== 200) return json({ error: state.error }, state.status);
    const meta = state.meta;

    if (parts.length === 2) {
      if (method !== "DELETE") return json({ error: "method not allowed" }, 405);
      if (this.bearer(request) !== meta.hostToken) return json({ error: "unauthorized" }, 401);
      await this.shutdown(4000, "closed");
      return new Response(null, { status: 204 });
    }
    if (action === "pair-codes" && method === "POST") return this.createPairCode(request, meta);
    if (action === "pair" && method === "POST") return this.pair(request, meta);
    if (action === "ws" && method === "GET") return this.connect(request, meta);
    return json({ error: "not found" }, 404);
  }

  async init(room) {
    const existing = await this.ctx.storage.get(["meta", "expired"]);
    if (existing.get("meta") || existing.get("expired")) return json({ error: "conflict" }, 409);
    const createdAt = Date.now();
    const ttl = Number(this.env.ROOM_TTL_MS) || 21600000;
    const meta = {
      room,
      createdAt,
      expiresAt: createdAt + ttl,
      hostToken: randomId(),
      pairCodes: [randomId()],
      devices: [],
    };
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(meta.expiresAt);
    return json(
      { room, hostToken: meta.hostToken, pairCode: meta.pairCodes[0], expiresAt: meta.expiresAt },
      201,
    );
  }

  async loadState() {
    const got = await this.ctx.storage.get(["meta", "expired"]);
    if (got.get("expired")) return { status: 410, error: "expired" };
    const meta = got.get("meta");
    if (!meta) return { status: 404, error: "not found" };
    // アラームが遅れた場合の保険
    if (Date.now() >= meta.expiresAt) {
      await this.shutdown(4000, "expired");
      return { status: 410, error: "expired" };
    }
    return { status: 200, meta };
  }

  bearer(request) {
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") || "");
    return m ? m[1] : null;
  }

  // token から role と deviceId を引く。該当なしは null
  identify(meta, token) {
    if (!token) return null;
    if (token === meta.hostToken) return { role: "program", deviceId: null };
    const device = meta.devices.find((d) => d.token === token);
    return device ? { role: "control", deviceId: device.deviceId } : null;
  }

  async createPairCode(request, meta) {
    if (!this.identify(meta, this.bearer(request))) return json({ error: "unauthorized" }, 401);
    if (meta.devices.length >= MAX_DEVICES) return json({ error: "device limit" }, 409);
    const pairCode = randomId();
    meta.pairCodes.push(pairCode);
    while (meta.pairCodes.length > MAX_PAIR_CODES) meta.pairCodes.shift();
    await this.ctx.storage.put("meta", meta);
    return json({ pairCode }, 201);
  }

  async pair(request, meta) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const code = body && typeof body.code === "string" ? body.code : "";
    if (meta.devices.length >= MAX_DEVICES) return json({ error: "device limit" }, 409);
    const idx = meta.pairCodes.indexOf(code);
    if (!code || idx === -1) return json({ error: "invalid code" }, 403);
    meta.pairCodes.splice(idx, 1);
    const device = { deviceId: randomId(), token: randomId() };
    meta.devices.push(device);
    await this.ctx.storage.put("meta", meta);
    return json({ deviceId: device.deviceId, deviceToken: device.token }, 201);
  }

  connect(request, meta) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "upgrade required" }, 426);
    }
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tokenProto = protocols.find((p) => p.startsWith("t."));
    const who = protocols.includes(PROTOCOL) && tokenProto
      ? this.identify(meta, tokenProto.slice(2))
      : null;
    if (!who) return json({ error: "unauthorized" }, 401);

    // program は 1 本だけ。古い方を切る
    if (who.role === "program") {
      for (const old of this.ctx.getWebSockets("program")) {
        const att = old.deserializeAttachment() || {};
        try {
          old.serializeAttachment({ ...att, replaced: true });
        } catch {}
        try {
          old.close(4001, "replaced");
        } catch {}
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [who.role]);
    server.serializeAttachment({ role: who.role, deviceId: who.deviceId });

    const counts = this.counts();
    server.send(JSON.stringify({
      v: 1, type: "relay", event: "welcome",
      role: who.role, deviceId: who.deviceId, expiresAt: meta.expiresAt, ...counts,
    }));
    this.broadcast(
      { v: 1, type: "relay", event: "join", role: who.role, deviceId: who.deviceId, ...counts },
      server,
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": PROTOCOL },
    });
  }

  // 生きている接続だけを返す（close 済み・置き換え済みは除く）
  live(tag) {
    return this.ctx.getWebSockets(tag).filter((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const att = ws.deserializeAttachment();
      return att && !att.replaced && !att.closed;
    });
  }

  counts() {
    return { controls: this.live("control").length, program: this.live("program").length > 0 };
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const ws of this.live()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {}
    }
  }

  allowRate(ws) {
    const now = Date.now();
    let r = this.rates.get(ws);
    if (!r || now - r.start >= 1000) {
      r = { start: now, count: 0 };
      this.rates.set(ws, r);
    }
    r.count += 1;
    return r.count <= RATE_LIMIT_PER_SEC;
  }

  async webSocketMessage(ws, message) {
    if (!this.allowRate(ws)) return;
    if (typeof message !== "string") return;
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.type !== "string") return;

    const att = ws.deserializeAttachment();
    if (!att || att.replaced || att.closed) return;
    if (!ALLOWED_TYPES[att.role]?.has(msg.type)) return;
    if (msg.type === "key" && !isAllowedKey(msg.key)) return;

    msg.from = att.role === "program" ? "program" : att.deviceId;
    const data = JSON.stringify(msg);
    const targets = att.role === "program" ? this.live("control") : this.live("program");
    for (const t of targets) {
      try {
        t.send(data);
      } catch {}
    }
  }

  async webSocketClose(ws, code, reason) {
    this.handleGone(ws);
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    this.handleGone(ws);
  }

  handleGone(ws) {
    this.rates.delete(ws);
    const att = ws.deserializeAttachment();
    // 置き換え・失効でサーバから切ったものは leave を流さない
    if (!att || att.replaced || att.closed) return;
    try {
      ws.serializeAttachment({ ...att, closed: true });
    } catch {}
    this.broadcast(
      { v: 1, type: "relay", event: "leave", role: att.role, deviceId: att.deviceId, ...this.counts() },
      ws,
    );
  }

  async alarm() {
    await this.shutdown(4000, "expired");
  }

  // 全接続を閉じてストレージを消し、以後は 410 にする
  async shutdown(code, reason) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      try {
        ws.serializeAttachment({ ...att, closed: true });
      } catch {}
      try {
        ws.close(code, reason);
      } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("expired", true);
  }
}
