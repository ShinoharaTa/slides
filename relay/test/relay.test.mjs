// relay の受け入れテスト。wrangler dev を子プロセスで起動し、終わったら止める。
// 通常 TTL のサーバと、TTL を 3 秒にしたサーバの 2 回起動する。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;
const ORIGIN = "http://127.0.0.1:5500";
const PROTO = "slides-relay.v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

// ---- wrangler dev の起動・停止 ----

async function startServer(extraArgs = []) {
  const persist = mkdtempSync(join(tmpdir(), "slides-relay-test-"));
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", persist, ...extraArgs],
    { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
    try {
      await fetch(`${BASE}/`);
      return { child, persist, log: () => log };
    } catch {
      await sleep(300);
    }
  }
  stopServer({ child, persist });
  throw new Error(`wrangler dev did not start:\n${log}`);
}

async function stopServer(server) {
  if (!server) return;
  const { child, persist } = server;
  if (child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const t = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 5000);
    await exited;
    clearTimeout(t);
  }
  rmSync(persist, { recursive: true, force: true });
}

// ---- HTTP / WS ヘルパ ----

async function http(method, path, { origin = ORIGIN, token, body } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, data };
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    this.closed = null;
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? { binary: true } : JSON.parse(data.toString());
      this.messages.push(msg);
      this.flush();
    });
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.flush();
    });
  }
  flush() {
    for (const w of [...this.waiters]) w();
  }
  // 条件に合うメッセージ（cursor 以降）を待つ
  waitFor(pred, timeout = 3000, from = 0) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.messages.slice(from).find(pred);
        if (found) {
          done();
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timeout waiting for message; got ${JSON.stringify(this.messages.slice(from))}`));
      }, timeout);
      const done = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
      };
      this.waiters.push(check);
      check();
    });
  }
  waitClose(timeout = 8000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closed) {
          done();
          resolve(this.closed);
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error("timeout waiting for close"));
      }, timeout);
      const done = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
      };
      this.waiters.push(check);
      check();
    });
  }
  send(obj) {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
  mark() {
    return this.messages.length;
  }
  since(cursor) {
    return this.messages.slice(cursor);
  }
  close() {
    this.ws.close();
  }
}

// 接続できたら Client、upgrade されなかったら { status }
function connect(room, token, { origin = ORIGIN, protocols } = {}) {
  return new Promise((resolve, reject) => {
    const protos = protocols ?? [PROTO, `t.${token}`];
    // wrangler dev ではサーバ側から閉じたとき TCP の終了が遅れるので、close フレーム受信後 1 秒で切る
    const opts = { closeTimeout: 1000, ...(origin ? { origin } : {}) };
    const ws = new WebSocket(`${WS_BASE}/rooms/${room}/ws`, protos, opts);
    const client = new Client(ws);
    ws.once("open", () => resolve(client));
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once("error", (e) => {
      if (ws.readyState !== WebSocket.OPEN) reject(e);
    });
  });
}

// welcome 付きで接続する
async function joinRoom(room, token) {
  const c = await connect(room, token);
  assert.ok(c instanceof Client, `connect failed: ${JSON.stringify(c)}`);
  c.welcome = await c.waitFor((m) => m.type === "relay" && m.event === "welcome");
  return c;
}

// ---- 通常 TTL のテスト ----

async function mainSuite() {
  // Origin / CORS
  assert.equal((await http("POST", "/rooms", { origin: null })).status, 403);
  assert.equal((await http("POST", "/rooms", { origin: "https://evil.example" })).status, 403);
  assert.equal((await http("POST", "/rooms", { origin: "https://a.b.bluesky-meetup-slide2026.pages.dev" })).status, 403);
  ok("HTTP: Origin なし／許可外は 403");

  const pre = await fetch(`${BASE}/rooms`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://preview.bluesky-meetup-slide2026.pages.dev",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://preview.bluesky-meetup-slide2026.pages.dev");
  assert.match(pre.headers.get("access-control-allow-headers"), /authorization/);
  assert.match(pre.headers.get("access-control-allow-methods"), /DELETE/);
  const preBad = await fetch(`${BASE}/rooms`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(preBad.status, 403);
  ok("CORS preflight: 許可 Origin をそのまま返す／許可外は 403");

  for (const o of ["https://bluesky-meetup-slide2026.pages.dev", "http://localhost:3000"]) {
    const r = await http("POST", "/rooms", { origin: o });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("access-control-allow-origin"), o);
  }
  ok("許可 Origin（本番・localhost）でルーム作成でき、ACAO が付く");

  // ルーム作成
  const created = await http("POST", "/rooms");
  assert.equal(created.status, 201);
  const { room, hostToken, pairCode } = created.data;
  for (const v of [room, hostToken, pairCode]) assert.match(v, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(created.data.expiresAt > Date.now() + 6 * 3600 * 1000 - 60000);
  ok("POST /rooms → 201 {room, hostToken, pairCode, expiresAt}");

  assert.equal((await http("POST", `/rooms/${"A".repeat(22)}/pair`, { body: { code: "x" } })).status, 404);
  assert.equal((await http("POST", "/rooms/short/pair", { body: { code: "x" } })).status, 404);
  ok("存在しないルームは 404");

  // ペアリング
  const p1 = await http("POST", `/rooms/${room}/pair`, { body: { code: pairCode } });
  assert.equal(p1.status, 201);
  const d1 = p1.data;
  assert.match(d1.deviceId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await http("POST", `/rooms/${room}/pair`, { body: { code: pairCode } })).status, 403);
  assert.equal((await http("POST", `/rooms/${room}/pair`, { body: { code: "nope" } })).status, 403);
  ok("ペアリング成功、使用済みコードと不正コードは 403");

  assert.equal((await http("POST", `/rooms/${room}/pair-codes`, { token: "bad" })).status, 401);
  assert.equal((await http("POST", `/rooms/${room}/pair-codes`)).status, 401);
  const code2 = await http("POST", `/rooms/${room}/pair-codes`, { token: d1.deviceToken });
  assert.equal(code2.status, 201);
  const d2 = (await http("POST", `/rooms/${room}/pair`, { body: { code: code2.data.pairCode } })).data;
  assert.ok(d2.deviceToken);
  ok("pair-codes: 不正トークン 401、deviceToken でも発行できる");

  // 未使用コードは最大 4 個（古いものから捨てる）
  const codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await http("POST", `/rooms/${room}/pair-codes`, { token: hostToken })).data.pairCode);
  }
  assert.equal((await http("POST", `/rooms/${room}/pair`, { body: { code: codes[0] } })).status, 403);
  ok("未使用コードは 4 個まで、超えたら古いものから無効");

  // WS の拒否
  assert.equal((await connect(room, "bad")).status, 401);
  assert.equal((await connect(room, null, { protocols: [PROTO] })).status, 401);
  assert.equal((await connect(room, null, { protocols: [`t.${hostToken}`] })).status, 401);
  assert.equal((await connect(room, hostToken, { origin: null })).status, 403);
  assert.equal((await connect(room, hostToken, { origin: "https://evil.example" })).status, 403);
  ok("WS: 不正トークン 401、Origin なし／許可外 403");

  // 接続と join / welcome
  const prog = await joinRoom(room, hostToken);
  assert.equal(prog.ws.protocol, PROTO);
  assert.deepEqual(
    { ...prog.welcome, expiresAt: undefined },
    { v: 1, type: "relay", event: "welcome", role: "program", deviceId: null, expiresAt: undefined, controls: 0, program: true },
  );
  assert.equal(prog.welcome.expiresAt, created.data.expiresAt);

  let pm = prog.mark();
  const c1 = await joinRoom(room, d1.deviceToken);
  assert.equal(c1.welcome.role, "control");
  assert.equal(c1.welcome.deviceId, d1.deviceId);
  assert.equal(c1.welcome.controls, 1);
  assert.equal(c1.welcome.program, true);
  const j1 = await prog.waitFor((m) => m.event === "join", 3000, pm);
  assert.deepEqual(j1, { v: 1, type: "relay", event: "join", role: "control", deviceId: d1.deviceId, controls: 1, program: true });

  pm = prog.mark();
  let c1m = c1.mark();
  const c2 = await joinRoom(room, d2.deviceToken);
  assert.equal(c2.welcome.controls, 2);
  const j2p = await prog.waitFor((m) => m.event === "join", 3000, pm);
  const j2c = await c1.waitFor((m) => m.event === "join", 3000, c1m);
  assert.equal(j2p.deviceId, d2.deviceId);
  assert.equal(j2p.controls, 2);
  assert.deepEqual(j2c, j2p);
  ok("welcome / join が program と control に届く");

  // 双方向の中継
  pm = prog.mark();
  let c2m = c2.mark();
  c1.send({ v: 1, type: "key", key: "ArrowRight", from: "spoofed" });
  const got = await prog.waitFor((m) => m.type === "key", 3000, pm);
  assert.deepEqual(got, { v: 1, type: "key", key: "ArrowRight", from: d1.deviceId });
  await sleep(300);
  assert.equal(c2.since(c2m).length, 0, "control 同士に届いてはいけない");
  ok("control → program に from=deviceId 付きで届き、他の control には届かない");

  c1m = c1.mark();
  c2m = c2.mark();
  pm = prog.mark();
  prog.send({ v: 1, type: "state", index: 3, total: 10, from: "x" });
  const s1 = await c1.waitFor((m) => m.type === "state", 3000, c1m);
  const s2 = await c2.waitFor((m) => m.type === "state", 3000, c2m);
  assert.deepEqual(s1, { v: 1, type: "state", index: 3, total: 10, from: "program" });
  assert.deepEqual(s2, s1);
  await sleep(200);
  assert.equal(prog.since(pm).length, 0, "program 自身には返らない");
  ok("program → 全 control に from=program 付きで届く");

  for (const t of ["hello", "pvw", "take", "reload"]) {
    pm = prog.mark();
    c1.send({ v: 1, type: t });
    await prog.waitFor((m) => m.type === t, 3000, pm);
  }
  for (const t of ["tally", "stale"]) {
    c1m = c1.mark();
    prog.send({ v: 1, type: t });
    await c1.waitFor((m) => m.type === t, 3000, c1m);
  }
  const keysOk = ["ArrowLeft", "ArrowUp", "ArrowDown", " ", "PageUp", "PageDown", "Home", "End", "0", "9", "a", "m", "z"];
  pm = prog.mark();
  for (const k of keysOk) c1.send({ type: "key", key: k });
  await prog.waitFor((m) => m.key === "z", 3000, pm);
  assert.deepEqual(prog.since(pm).map((m) => m.key), keysOk);
  ok("許可 type と許可 key はすべて通る");

  // 捨てられるもの
  await sleep(1100);
  pm = prog.mark();
  c1m = c1.mark();
  c2m = c2.mark();
  const drops = [
    { type: "key", key: "ArrowRight", pad: "x".repeat(2100) },
    { type: "key", key: "f" },
    { type: "key", key: "p" },
    { type: "key", key: "s" },
    { type: "key", key: "Escape" },
    { type: "key", key: "F" },
    { type: "key", key: "ab" },
    { type: "key" },
    { type: "state" },
    { type: "relay", event: "join" },
    { type: "evil" },
    { type: 1 },
    [1, 2],
  ];
  for (const d of drops) c1.send(d);
  c1.send("not json");
  c1.ws.send(Buffer.from(JSON.stringify({ type: "key", key: "a" })), { binary: true });
  prog.send({ type: "key", key: "a" });
  prog.send({ type: "hello" });
  prog.send({ type: "relay" });
  c1.send({ type: "key", key: "b", marker: true });
  await prog.waitFor((m) => m.marker, 3000, pm);
  assert.deepEqual(prog.since(pm), [{ type: "key", key: "b", marker: true, from: d1.deviceId }]);
  await sleep(200);
  assert.equal(c1.since(c1m).length, 0);
  assert.equal(c2.since(c2m).length, 0);
  assert.equal(c1.closed, null, "不正メッセージで接続は切れない");
  ok("2KB 超・非 JSON・バイナリ・許可外 type・許可外 key（f p s Escape F）・relay は届かず、接続も切れない");

  // レート制限
  await sleep(1100);
  pm = prog.mark();
  for (let i = 0; i < 25; i++) c1.send({ type: "key", key: "ArrowRight", seq: i });
  await sleep(600);
  assert.deepEqual(prog.since(pm).map((m) => m.seq), [...Array(20).keys()]);
  await sleep(600);
  pm = prog.mark();
  c1.send({ type: "key", key: "ArrowRight", seq: 99 });
  await prog.waitFor((m) => m.seq === 99, 3000, pm);
  ok("1 接続あたり 21 件/秒目以降は捨てられ、次の窓で再び通る");

  // leave
  pm = prog.mark();
  c1m = c1.mark();
  c2.close();
  const lp = await prog.waitFor((m) => m.event === "leave", 3000, pm);
  const lc = await c1.waitFor((m) => m.event === "leave", 3000, c1m);
  assert.deepEqual(lp, { v: 1, type: "relay", event: "leave", role: "control", deviceId: d2.deviceId, controls: 1, program: true });
  assert.deepEqual(lc, lp);
  ok("leave が program と残りの control に届く");

  // 5 台目は 409
  const spare = (await http("POST", `/rooms/${room}/pair-codes`, { token: hostToken })).data.pairCode;
  for (const code of codes.slice(2, 4)) {
    assert.equal((await http("POST", `/rooms/${room}/pair`, { body: { code } })).status, 201);
  }
  assert.equal((await http("POST", `/rooms/${room}/pair`, { body: { code: spare } })).status, 409);
  assert.equal((await http("POST", `/rooms/${room}/pair-codes`, { token: hostToken })).status, 409);
  ok("5 台目のペアリングとコード発行は 409");

  // program の置き換え
  c1m = c1.mark();
  const prog2 = await joinRoom(room, hostToken);
  const replaced = await prog.waitClose();
  assert.deepEqual(replaced, { code: 4001, reason: "replaced" });
  assert.equal(prog2.welcome.controls, 1);
  assert.equal(prog2.welcome.program, true);
  const jp = await c1.waitFor((m) => m.event === "join" && m.role === "program", 3000, c1m);
  assert.equal(jp.program, true);
  pm = prog2.mark();
  c1.send({ type: "key", key: "Home" });
  await prog2.waitFor((m) => m.key === "Home", 3000, pm);
  ok("program 2 本目で 1 本目が 4001 で切れ、新しい方に届く");

  // program の leave
  c1m = c1.mark();
  prog2.close();
  const lpg = await c1.waitFor((m) => m.event === "leave", 3000, c1m);
  assert.deepEqual(lpg, { v: 1, type: "relay", event: "leave", role: "program", deviceId: null, controls: 1, program: false });
  const prog3 = await joinRoom(room, hostToken);
  ok("program の leave で program:false が届く");

  // DELETE
  assert.equal((await http("DELETE", `/rooms/${room}`, { token: d1.deviceToken })).status, 401);
  assert.equal((await http("DELETE", `/rooms/${room}`, { token: hostToken })).status, 204);
  assert.deepEqual(await prog3.waitClose(), { code: 4000, reason: "closed" });
  assert.deepEqual(await c1.waitClose(), { code: 4000, reason: "closed" });
  assert.equal((await connect(room, hostToken)).status, 410);
  assert.equal((await connect(room, d1.deviceToken)).status, 410);
  assert.equal((await http("POST", `/rooms/${room}/pair`, { body: { code: codes[4] } })).status, 410);
  assert.equal((await http("POST", `/rooms/${room}/pair-codes`, { token: hostToken })).status, 410);
  assert.equal((await http("DELETE", `/rooms/${room}`, { token: hostToken })).status, 410);
  ok("DELETE /rooms/:room で全接続が 4000 で切れ、以後 410");
}

// ---- TTL 短縮のテスト ----

async function ttlSuite() {
  const created = await http("POST", "/rooms", { origin: "https://extra.example" });
  assert.equal(created.status, 201, "EXTRA_ORIGINS の Origin で作成できる");
  assert.equal((await http("POST", "/rooms", { origin: "https://extra.example.evil" })).status, 403);
  ok("EXTRA_ORIGINS は完全一致で許可");

  const { room, hostToken, pairCode, expiresAt } = created.data;
  assert.ok(expiresAt - Date.now() <= 3000 && expiresAt - Date.now() > 1000);
  const extra = (await http("POST", `/rooms/${room}/pair-codes`, { token: hostToken })).data.pairCode;
  const dev = (await http("POST", `/rooms/${room}/pair`, { body: { code: pairCode } })).data;
  const prog = await joinRoom(room, hostToken);
  const ctl = await joinRoom(room, dev.deviceToken);
  assert.deepEqual(await prog.waitClose(10000), { code: 4000, reason: "expired" });
  assert.deepEqual(await ctl.waitClose(10000), { code: 4000, reason: "expired" });
  ok("TTL 経過で全接続が 4000 expired で切れる");

  assert.equal((await connect(room, hostToken)).status, 410);
  assert.equal((await connect(room, dev.deviceToken)).status, 410);
  assert.equal((await http("POST", `/rooms/${room}/pair`, { body: { code: extra } })).status, 410);
  assert.equal((await http("POST", `/rooms/${room}/pair-codes`, { token: hostToken })).status, 410);
  ok("失効後の再接続・ペアリングは 410");
}

let server;
let failed = false;
try {
  server = await startServer();
  await mainSuite();
  await stopServer(server);
  server = await startServer(["--var", "ROOM_TTL_MS:3000", "--var", "EXTRA_ORIGINS:https://extra.example"]);
  await ttlSuite();
} catch (e) {
  failed = true;
  console.error("not ok -", e);
  if (server) console.error("---- wrangler log (tail) ----\n" + server.log().slice(-3000));
} finally {
  await stopServer(server);
}
console.log(failed ? `FAILED after ${passed} passing checks` : `all ${passed} checks passed`);
process.exit(failed ? 1 : 0);
