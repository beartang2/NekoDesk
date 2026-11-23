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
/** 다시 맞추기(heads): 한 번에 돌려주는 머리 수. 본문이 없어 한 줄 100바이트 남짓 */
const HEADS_MAX = 1000;
/** 다시 맞추기(fetch): 한 번에 묻는 번호 수(D1 묶는 값 100개 = 번호 50쌍) */
const FETCH_MAX = 50;
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
  const body = (await req.json().catch(() => null)) as { since?: unknown; push?: unknown; active_at?: unknown; name?: unknown } | null;
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
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  const stmts: D1Stmt[] = [
    // name: 기기가 지금 이름을 같이 보낸다(등록 뒤 이름이 바뀌었거나, 예전에 종류 이름으로만 등록한 기기). 안 보내면 그대로
    db.prepare("UPDATE devices SET last_seen = ?2, last_active = MAX(COALESCE(last_active, 0), ?3), name = COALESCE(?4, name) WHERE id = ?1").bind(device, now, active, name),
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
  return json({ records, seq, more, rejected, walk: await walkNow(db) });
}

// ── 다시 맞추기(docs/neko-sync.md §4.5): 기기가 가끔 서버 기록 목록과 제 사본을 견준다 ─────────────────────────
// 보통 동기화(sync)는 순번 뒤의 것만 주고받아 한 번 빠진 기록은 다시 오가지 않았다. 표·인덱스는 그대로다(records 의 기본 키
// (coll, id) 순으로 읽는다). 기기 인증은 sync 와 같다(route).

/** 기록 머리(본문 없이)를 (coll, id) 순으로 HEADS_MAX 개씩. after = 지난 쪽의 마지막 [coll, id] */
async function heads(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { after?: unknown } | null;
  const a = Array.isArray(body?.after) && body!.after.length === 2 && body!.after.every((x) => typeof x === "string") ? (body!.after as string[]) : ["", ""];
  const { results } = await env.DB.prepare(
    "SELECT coll, id, parent, ts, device, deleted, cut FROM records WHERE (coll, id) > (?1, ?2) ORDER BY coll, id LIMIT ?3",
  ).bind(a[0], a[1], HEADS_MAX + 1).all<Omit<Rec, "blob" | "seq">>();
  const page = results.slice(0, HEADS_MAX), last = page.at(-1);
  return json({ heads: page, next: results.length > HEADS_MAX && last ? [last.coll, last.id] : null });
}

/** 고른 기록(본문 포함)을 받는다. 번호는 FETCH_MAX 개까지, 본문 합이 PULL_BYTES 를 넘으면 나머지 번호는 rest 로 돌려준다 */
async function fetchRecords(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { keys?: unknown } | null;
  const keys = (Array.isArray(body?.keys) ? body!.keys : []).filter(
    (k): k is [string, string] => Array.isArray(k) && k.length === 2 && typeof k[0] === "string" && typeof k[1] === "string",
  );
  if (keys.length > FETCH_MAX) return fail(413, `keys ≤ ${FETCH_MAX}`);
  if (!keys.length) return json({ records: [], rest: [] });
  const list = keys.map((_, i) => `(?${i * 2 + 1}, ?${i * 2 + 2})`).join(", ");
  const { results } = await env.DB.prepare(`SELECT ${REC_COLS} FROM records WHERE (coll, id) IN (VALUES ${list})`)
    .bind(...keys.flat()).all<Rec>();
  const at = new Map(results.map((r) => [`${r.coll}\0${r.id}`, r]));
  const records: Rec[] = [], rest: [string, string][] = [];
  let bytes = 0;
  for (const k of keys) {
    const r = at.get(`${k[0]}\0${k[1]}`);
    if (!r) continue; // 그새 없어졌다(지운 세션의 말)
    if (records.length && bytes + (r.blob?.length ?? 0) > PULL_BYTES) { rest.push(k); continue; }
    bytes += (r.blob?.length ?? 0) + 200;
    records.push(r);
  }
  return json({ records, rest });
}

// ── 산책: 기기들이 같은 산책 하나를 나눠 쓴다(docs/neko-sync.md §5.4) ─────────────
// 기기마다 따로 나가면 끼니마다 두 번 나가고 비용·선물·일지가 두 벌이 된다. 마지막 산책 하나(시작·끝·나간 기기)를
// meta 의 'walk' 에 둔다(표를 더하지 않는다). 대화 내용은 없다 — 시각과 기기 번호뿐이다.
// 언제 나갈지는 기기가 정하고(끼니·2시간 간격, lib/walk nextWalkAt), 서버는 둘이 같이 나가는 것만 막는다.
interface Walk { start: number; end: number; device: string }

async function walkNow(db: D1Database): Promise<Walk | null> {
  const raw = (await db.prepare("SELECT value FROM meta WHERE key = 'walk'").first<{ value: string }>())?.value;
  try { return raw ? (JSON.parse(raw) as Walk) : null; } catch { return null; }
}

const whole = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
/** 산책 한 번의 상한(기기는 30분 남짓). 끝 시각을 터무니없이 멀리 적어 다른 기기를 묶어 두지 못하게 */
const WALK_MAX_MS = 3 * 60 * 60_000;

/** 나가기 전에 선점한다. prev = 이 기기가 아는 지난 산책의 시작(없으면 0). 그사이 다른 기기가 나갔으면(prev 가 낡았거나 아직 산책 중) 진다. */
async function walkClaim(req: Request, env: Env, device: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { start?: unknown; end?: unknown; prev?: unknown } | null;
  const start = whole(body?.start), end = whole(body?.end), prev = whole(body?.prev);
  if (start === null || end === null || prev === null || end <= start || end - start > WALK_MAX_MS) return fail(400, "walk");
  const next = JSON.stringify({ start, end, device } satisfies Walk);
  // 한 문장으로 견주고 바꾼다: 없으면 넣고, 있으면 지난 산책이 내가 아는 그것이고 이미 끝났을 때만 바꾼다
  const res = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('walk', ?1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value
     WHERE CAST(json_extract(meta.value, '$.start') AS INTEGER) = ?2 AND CAST(json_extract(meta.value, '$.end') AS INTEGER) <= ?3`,
  ).bind(next, prev, Date.now()).run();
  return json({ ok: res.meta.changes > 0, walk: await walkNow(env.DB) });
}

/** 나간 기기가 끝 시각을 고친다(서둘러 돌아옴·도착). 다른 기기의 산책이나 지난 산책은 못 고친다. */
async function walkEnd(req: Request, env: Env, device: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { start?: unknown; end?: unknown } | null;
  const start = whole(body?.start), end = whole(body?.end);
  if (start === null || end === null || end < start || end - start > WALK_MAX_MS) return fail(400, "walk");
  await env.DB.prepare(
    `UPDATE meta SET value = json_set(value, '$.end', ?1)
     WHERE key = 'walk' AND CAST(json_extract(value, '$.start') AS INTEGER) = ?2 AND json_extract(value, '$.device') = ?3`,
  ).bind(end, start, device).run();
  return json({ walk: await walkNow(env.DB) });
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname, method = req.method;
  if (method === "GET" && path === "/v1/health") return new Response(null, { status: 204 });
  if (method === "POST" && path === "/v1/devices") return register(req, env);

  const device = await authed(req, env);
  if (!device) return fail(401, "token");

  if (method === "POST" && path === "/v1/sync") return sync(req, env, device);
  if (method === "POST" && path === "/v1/heads") return heads(req, env);
  if (method === "POST" && path === "/v1/fetch") return fetchRecords(req, env);
  if (method === "POST" && path === "/v1/walk/claim") return walkClaim(req, env, device);
  if (method === "POST" && path === "/v1/walk/end") return walkEnd(req, env, device);
  if (method === "POST" && path === "/v1/pair") {
    const code = randomToken(16), expires = Date.now() + PAIR_MS;
    // 기기당 살아 있는 코드는 하나: 새로 만들면 그 기기의 이전 코드는 지운다
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pair_codes WHERE expires <= ?1 OR creator = ?2").bind(Date.now(), device),
      env.DB.prepare("INSERT INTO pair_codes (code_hash, expires, creator) VALUES (?1, ?2, ?3)").bind(await sha256(code), expires, device),
    ]);
    return json({ code, expires });
  }
  // 짝 코드를 모두 무효로(열쇠 바꾸기 첫 단계 — 옛 짝 문자열로 그사이 새 기기가 들어오지 못하게)
  if (method === "DELETE" && path === "/v1/pair") {
    await env.DB.prepare("DELETE FROM pair_codes").run();
    return json({ ok: true });
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
  // 열쇠 바꾸기: 기록과 짝 코드를 다 비운다(옛 짝 문자열엔 옛 열쇠가 들어 있다). 기기는 남는다.
  // 이 순번 앞에서 멈춘 기기는 처음부터 다시 받는다
  if (method === "POST" && path === "/v1/reset") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM records"),
      env.DB.prepare("DELETE FROM pair_codes"),
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
