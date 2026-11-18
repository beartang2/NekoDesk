/**
 * 네코 동기화 서버(docs/neko-sync.md §4). 한 사람용이다 — 계정은 없고 기기 토큰만 있다.
 * 서버는 기록의 머리(종류·번호·세션·시각·기기·지움)만 읽고, 내용(blob)은 기기가 잠근 암호문이다.
 *
 * 산책(cron·walk/*)·ntfy 는 4단계. 그 엔드포인트 자리는 문서 §4.2 에만 있다.
 */

// wrangler 가 esbuild 로 묶기만 하고 타입 검사는 안 한다. 쓰는 만큼만 적는다(@cloudflare/workers-types 를 안 들인다).
interface D1Result<T> { results: T[] }
interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown[]> }
interface Env { DB: D1; SETUP_TOKEN?: string }

const COLLS = new Set(["session", "msg", "memory", "todo", "event", "gift", "setting"]);
const PUSH_MAX = 20;
const PULL_MAX = 200;
const PULL_BYTES = 1_000_000;
/** 암호문 1MB → base64 로 4/3 */
const BLOB_MAX = Math.ceil((1_048_576 * 4) / 3) + 64;
/** 기기 시계가 이만큼 앞서면 거절한다(§9 기기 시계) */
const SKEW_MS = 10 * 60_000;
const PAIR_MS = 10 * 60_000;

interface Rec {
  coll: string; id: string; parent: string | null; ts: number; device: string;
  deleted: number; cut: number | null; blob: string | null; seq?: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, error: string) => json({ error }, status);

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 길이가 같을 때 끝까지 비교한다(SETUP_TOKEN 을 한 글자씩 맞혀 보지 못하게) */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function authed(req: Request, env: Env): Promise<string | null> {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const row = await env.DB.prepare("SELECT id FROM devices WHERE token_hash = ?1 AND revoked = 0")
    .bind(await sha256(m[1])).first<{ id: string }>();
  return row?.id ?? null;
}

async function register(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { name?: unknown; setup_token?: unknown; pair_code?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.slice(0, 80) : "";
  if (!name) return fail(400, "name");
  if (typeof body?.setup_token === "string") {
    if (!env.SETUP_TOKEN || !sameText(body.setup_token, env.SETUP_TOKEN)) return fail(403, "setup_token");
  } else if (typeof body?.pair_code === "string") {
    // 1회용: 지우면서 확인한다. 둘이 동시에 써도 한쪽만 지운다
    // 만든 기기가 끊겼으면 코드도 죽은 것이다
    const gone = await env.DB.prepare(
      `DELETE FROM pair_codes WHERE code_hash = ?1 AND expires > ?2
         AND creator IN (SELECT id FROM devices WHERE revoked = 0) RETURNING code_hash`)
      .bind(await sha256(body.pair_code), Date.now()).first();
    if (!gone) return fail(403, "pair_code");
  } else return fail(400, "setup_token | pair_code");
  const id = crypto.randomUUID(), token = randomToken();
  await env.DB.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, name, await sha256(token), Date.now()).run();
  return json({ device_id: id, token });
}

/** 받은 기록을 고르고 다듬는다. 기기는 자기 id 로만 쓴다(device 는 토큰에서) */
function clean(r: unknown, device: string, now: number): Rec | string {
  const o = r as Partial<Rec> | null;
  if (!o || typeof o !== "object") return "shape";
  if (typeof o.coll !== "string" || !COLLS.has(o.coll)) return "coll";
  if (typeof o.id !== "string" || !o.id || o.id.length > 200) return "id";
  if (!Number.isSafeInteger(o.ts) || (o.ts as number) <= 0) return "ts";
  if ((o.ts as number) > now + SKEW_MS) return "clock";
  const parent = typeof o.parent === "string" ? o.parent : null;
  if (o.coll === "msg" && !parent) return "parent";
  const deleted = o.deleted ? 1 : 0;
  if (o.coll === "msg" && deleted) return "msg_deleted";
  const cut = Number.isSafeInteger(o.cut) ? (o.cut as number) : null;
  const blob = typeof o.blob === "string" ? o.blob : null;
  if (blob && blob.length > BLOB_MAX) return "too_big";
  if (!deleted && !blob) return "blob";
  return { coll: o.coll, id: o.id, parent, ts: o.ts as number, device, deleted, cut: o.coll === "session" ? cut : null, blob: deleted ? null : blob };
}

const SEQ = "(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'seq')";

/**
 * 올리기 한 건의 문장들. 한 batch(= 트랜잭션) 안에서 순번을 매기므로, 받는 쪽이 나중 순번을 먼저 보고
 * 앞 순번을 놓치는 일이 없다.
 *  - msg: 덧붙기만. 이미 있으면 그대로, 세션이 지워졌거나 cut 안쪽이면 버린다.
 *  - session: 사용자가 지운 것(deleted, cut 없음)은 늘 이기고 되돌릴 수 없다. 자동 삭제(deleted + cut)는
 *    cut 보다 새 메시지가 있으면 거절한다. 나머지는 (ts, device) 가 큰 쪽.
 *    세션이 지워졌거나 cut 이 생기면 그 메시지들을 지운다.
 *  - 나머지: (ts, device) 가 큰 쪽이 이긴다.
 */
function writes(db: D1, r: Rec, i: number): D1Stmt[] {
  const seq = `${SEQ} + ${i + 1}`;
  const vals = [r.coll, r.id, r.parent, r.ts, r.device, r.deleted, r.cut, r.blob];
  const cols = "(coll, id, parent, ts, device, deleted, cut, blob, seq)";
  const set = "parent = excluded.parent, ts = excluded.ts, device = excluded.device, deleted = excluded.deleted, cut = excluded.cut, blob = excluded.blob, seq = excluded.seq";
  const newer = "(excluded.ts, excluded.device) > (records.ts, records.device)";
  if (r.coll === "msg") {
    return [db.prepare(
      `INSERT INTO records ${cols} SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${seq}
       WHERE NOT EXISTS (SELECT 1 FROM records s WHERE s.coll = 'session' AND s.id = ?3 AND (s.deleted = 1 OR s.cut >= ?4))
       ON CONFLICT (coll, id) DO NOTHING`,
    ).bind(...vals)];
  }
  if (r.coll === "session") {
    const prune = r.deleted && r.cut !== null;
    return [
      db.prepare(
        `INSERT INTO records ${cols} SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${seq}
         WHERE ${prune ? "NOT EXISTS (SELECT 1 FROM records m WHERE m.coll = 'msg' AND m.parent = ?2 AND m.ts > ?7)" : "1"}
         ON CONFLICT (coll, id) DO UPDATE SET ${set}
         WHERE NOT (records.deleted = 1 AND records.cut IS NULL)
           AND ((excluded.deleted = 1 AND excluded.cut IS NULL) OR ${newer})`,
      ).bind(...vals),
      db.prepare(
        `DELETE FROM records WHERE coll = 'msg' AND parent = ?1 AND EXISTS (
           SELECT 1 FROM records s WHERE s.coll = 'session' AND s.id = ?1 AND (s.deleted = 1 OR records.ts <= s.cut))`,
      ).bind(r.id),
    ];
  }
  return [db.prepare(
    `INSERT INTO records ${cols} VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${seq})
     ON CONFLICT (coll, id) DO UPDATE SET ${set} WHERE ${newer}`,
  ).bind(...vals)];
}

const REC_COLS = "coll, id, parent, ts, device, deleted, cut, blob, seq";

async function sync(req: Request, env: Env, device: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { since?: unknown; push?: unknown; active_at?: unknown } | null;
  const since = Number.isSafeInteger(body?.since) ? (body!.since as number) : 0;
  const push = Array.isArray(body?.push) ? body!.push : [];
  if (push.length > PUSH_MAX) return fail(413, `push ≤ ${PUSH_MAX}`);
  const now = Date.now();
  const db = env.DB;

  const rejected: { coll: string; id: string; reason: string }[] = [];
  const good: Rec[] = [];
  for (const raw of push) {
    const r = clean(raw, device, now);
    if (typeof r === "string") {
      const o = raw as { coll?: unknown; id?: unknown };
      rejected.push({ coll: String(o?.coll ?? ""), id: String(o?.id ?? ""), reason: r });
    } else good.push(r);
  }

  const active = Number.isSafeInteger(body?.active_at) ? Math.min(body!.active_at as number, now) : 0;
  const stmts: D1Stmt[] = [
    db.prepare("UPDATE devices SET last_seen = ?2, last_active = MAX(COALESCE(last_active, 0), ?3) WHERE id = ?1").bind(device, now, active),
  ];
  good.forEach((r, i) => stmts.push(...writes(db, r, i)));
  if (good.length) stmts.push(db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + ?1 WHERE key = 'seq'").bind(good.length));
  await db.batch(stmts);

  // 올린 것이 그대로 들어갔나. 아니면 거절로 알리고, 이긴 쪽 기록을 같이 내려 준다(기기가 그걸로 맞춘다)
  const winners: Rec[] = [];
  if (good.length) {
    const keys = good.map((_, i) => `(?${i * 2 + 1}, ?${i * 2 + 2})`).join(", ");
    const { results } = await db.prepare(`SELECT ${REC_COLS} FROM records WHERE (coll, id) IN (VALUES ${keys})`)
      .bind(...good.flatMap((r) => [r.coll, r.id])).all<Rec>();
    const at = new Map(results.map((r) => [`${r.coll}\0${r.id}`, r]));
    for (const r of good) {
      const cur = at.get(`${r.coll}\0${r.id}`);
      if (cur && cur.ts === r.ts && cur.device === r.device && cur.deleted === r.deleted) continue;
      const reason = r.coll === "msg" ? "gone" : r.coll === "session" && r.deleted && r.cut !== null ? "prune" : "lost";
      rejected.push({ coll: r.coll, id: r.id, reason });
      if (cur) winners.push(cur);
    }
  }

  const purged = Number((await db.prepare("SELECT value FROM meta WHERE key = 'purged_seq'").first<{ value: string }>())?.value ?? 0);
  if (since > 0 && since < purged) return json({ reset: true, records: [], seq: 0, more: false, rejected });

  const { results } = await db.prepare(`SELECT ${REC_COLS} FROM records WHERE seq > ?1 ORDER BY seq LIMIT ?2`)
    .bind(since, PULL_MAX + 1).all<Rec>();
  const records: Rec[] = [...winners];
  let bytes = 0, seq = since, more = false;
  for (const r of results) {
    bytes += (r.blob?.length ?? 0) + 200;
    if (records.length - winners.length >= PULL_MAX || (bytes > PULL_BYTES && records.length > winners.length)) { more = true; break; }
    records.push(r);
    seq = r.seq!;
  }
  return json({ records, seq, more, rejected });
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname, method = req.method;
  if (method === "GET" && path === "/v1/health") return new Response(null, { status: 204 });
  if (method === "POST" && path === "/v1/devices") return register(req, env);

  const device = await authed(req, env);
  if (!device) return fail(401, "token");

  if (method === "POST" && path === "/v1/sync") return sync(req, env, device);
  if (method === "POST" && path === "/v1/pair") {
    const code = randomToken(16), expires = Date.now() + PAIR_MS;
    // 기기당 살아 있는 코드는 하나: 새로 만들면 그 기기의 이전 코드는 지운다
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pair_codes WHERE expires <= ?1 OR creator = ?2").bind(Date.now(), device),
      env.DB.prepare("INSERT INTO pair_codes (code_hash, expires, creator) VALUES (?1, ?2, ?3)").bind(await sha256(code), expires, device),
    ]);
    return json({ code, expires });
  }
  if (method === "GET" && path === "/v1/devices") {
    const { results } = await env.DB.prepare("SELECT id, name, created_at, last_seen, last_active, revoked FROM devices ORDER BY created_at").all();
    return json({ devices: results, me: device });
  }
  const m = /^\/v1\/devices\/([\w-]+)$/.exec(path);
  if (method === "DELETE" && m) {
    await env.DB.batch([
      env.DB.prepare("UPDATE devices SET revoked = 1 WHERE id = ?1").bind(m[1]),
      env.DB.prepare("DELETE FROM pair_codes WHERE creator = ?1").bind(m[1]),
    ]);
    return json({ ok: true });
  }
  // 열쇠 바꾸기: 기록을 다 비운다. 기기·짝 코드는 남는다. 이 순번 앞에서 멈춘 기기는 처음부터 다시 받는다
  if (method === "POST" && path === "/v1/reset") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM records"),
      env.DB.prepare("UPDATE meta SET value = (SELECT value FROM meta WHERE key = 'seq') WHERE key = 'purged_seq'"),
    ]);
    return json({ ok: true });
  }
  return fail(404, "not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      // 내용은 안 싣는다 — 기기는 다음에 다시 맞춘다
      console.error(e);
      return fail(500, "server");
    }
  },
};
