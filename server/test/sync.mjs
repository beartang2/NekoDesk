// `wrangler dev`(로컬 D1)에 대고 도는 확인 스크립트(docs/neko-sync.md §8 2단계).
//   cd server && npm run migrate:local && npm run dev   # 다른 창
//   npm test                                             # SYNC_URL·SETUP_TOKEN 으로 바꿀 수 있다
// blob 은 여기선 아무 문자열이다 — 서버는 내용을 안 읽는다. 암호화 왕복은 Rust 테스트가 본다.
import assert from "node:assert/strict";

const URL_ = process.env.SYNC_URL ?? "http://127.0.0.1:8787";
const SETUP = process.env.SETUP_TOKEN ?? "dev-setup-token";
const run = Math.random().toString(36).slice(2, 8); // 같은 로컬 D1 에 여러 번 돌려도 안 겹치게

async function call(method, path, body, token) {
  const res = await fetch(URL_ + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const ok = async (...a) => {
  const r = await call(...a);
  assert.equal(r.status, 200, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const sync = (tok, since, push = []) => ok("POST", "/v1/sync", { since, push, active_at: Date.now() }, tok);
const rec = (coll, id, ts, extra = {}) => ({ coll, id, parent: null, ts, deleted: 0, cut: null, blob: `b64-${coll}-${id}-${ts}`, ...extra });
const find = (r, coll, id) => r.records.filter((x) => x.coll === coll && x.id === id).at(-1);

// 건강·등록
assert.equal((await call("GET", "/v1/health")).status, 204);
assert.equal((await call("POST", "/v1/devices", { name: "x", setup_token: "틀림" })).status, 403);
const A = await ok("POST", "/v1/devices", { name: "맥", setup_token: SETUP });
assert.equal((await call("POST", "/v1/sync", { since: 0 }, "nope")).status, 401);

// 짝 맞추기: 1회용
const { code } = await ok("POST", "/v1/pair", {}, A.token);
const B = await ok("POST", "/v1/devices", { name: "두 번째", pair_code: code });
assert.equal((await call("POST", "/v1/devices", { name: "셋", pair_code: code })).status, 403, "짝 코드는 한 번만");

// B 가 지금 어디까지 있는지
let bSince = (await sync(B.token, 0)).seq;
let aSince = (await sync(A.token, 0)).seq;
const now = Date.now();

// 올리기·받기
const s1 = `s1-${run}`;
let r = await sync(A.token, aSince, [rec("session", s1, now), rec("msg", `m1-${run}`, now + 1, { parent: s1 }), rec("memory", `k-${run}`, now)]);
assert.deepEqual(r.rejected, []);
aSince = r.seq;
r = await sync(B.token, bSince);
assert.ok(find(r, "msg", `m1-${run}`), "B 가 A 의 메시지를 받는다");
assert.equal(find(r, "msg", `m1-${run}`).device, A.device_id);
bSince = r.seq;

// 겨루기: 늦은 쓰기(작은 ts)는 지고, 이긴 값이 같이 내려온다
r = await sync(B.token, bSince, [rec("memory", `k-${run}`, now - 5)]);
assert.deepEqual(r.rejected.map((x) => x.reason), ["lost"]);
assert.equal(find(r, "memory", `k-${run}`).ts, now);
r = await sync(B.token, r.seq, [rec("memory", `k-${run}`, now + 5)]);
assert.deepEqual(r.rejected, []);
bSince = r.seq;
r = await sync(A.token, aSince);
assert.equal(find(r, "memory", `k-${run}`).device, B.device_id, "새 쓰기가 A 에 간다");
aSince = r.seq;

// 메시지는 덧붙기만: 같은 걸 다시 올려도 그대로
r = await sync(A.token, aSince, [rec("msg", `m1-${run}`, now + 1, { parent: s1, blob: "다른 내용" })]);
assert.deepEqual(r.rejected, []);

// 시계가 한참 앞선 쓰기는 거절
r = await sync(A.token, aSince, [rec("todo", `t-${run}`, now + 3_600_000)]);
assert.deepEqual(r.rejected.map((x) => x.reason), ["clock"]);

// cut(수동 요약): cut 안쪽 메시지는 지워지고, 그 뒤로 cut 안쪽을 올리면 버려진다
const s2 = `s2-${run}`;
await sync(A.token, aSince, [rec("session", s2, now), rec("msg", `old-${run}`, now + 1, { parent: s2 }), rec("msg", `keep-${run}`, now + 10, { parent: s2 })]);
r = await sync(A.token, aSince, [rec("session", s2, now + 20, { cut: now + 5 })]);
assert.deepEqual(r.rejected, []);
assert.ok(!find(r, "msg", `old-${run}`), "cut 안쪽 메시지는 서버에서 지워졌다");
assert.ok(find(r, "msg", `keep-${run}`), "cut 뒤 메시지는 남는다");
r = await sync(B.token, bSince, [rec("msg", `late-${run}`, now + 2, { parent: s2 })]);
assert.deepEqual(r.rejected.map((x) => x.reason), ["gone"]);

// 자동 삭제(prune) 거절: 기준보다 새 메시지가 있으면 안 지운다
const s3 = `s3-${run}`;
await sync(A.token, aSince, [rec("session", s3, now), rec("msg", `fresh-${run}`, now + 50, { parent: s3 })]);
r = await sync(B.token, bSince, [rec("session", s3, now + 60, { deleted: 1, cut: now + 40, blob: null })]);
assert.deepEqual(r.rejected.map((x) => x.reason), ["prune"]);
assert.equal(find(r, "session", s3).deleted, 0, "살아 있는 세션이 내려온다");
// 기준이 메시지보다 뒤면 지워진다
r = await sync(B.token, bSince, [rec("session", s3, now + 70, { deleted: 1, cut: now + 60, blob: null })]);
assert.deepEqual(r.rejected, []);
assert.ok(!find(r, "msg", `fresh-${run}`));
// 자동 삭제는 더 새 쓰기로 되살릴 수 있다
r = await sync(A.token, aSince, [rec("session", s3, now + 80)]);
assert.deepEqual(r.rejected, []);

// 사용자가 지운 세션: 늘 이기고, 되살릴 수 없고, 메시지도 못 붙는다
r = await sync(B.token, bSince, [rec("session", s1, now - 100, { deleted: 1, blob: null })]);
assert.deepEqual(r.rejected, [], "옛 ts 라도 지움이 이긴다");
r = await sync(A.token, aSince, [rec("session", s1, now + 500), rec("msg", `after-${run}`, now + 501, { parent: s1 })]);
assert.deepEqual(r.rejected.map((x) => x.reason).sort(), ["gone", "lost"]);
assert.equal(find(r, "session", s1).deleted, 1);
assert.ok(!find(r, "msg", `m1-${run}`), "지운 세션의 메시지는 서버에서도 지워졌다");

// 짝 코드는 기기당 하나: 새로 만들면 이전 것은 죽는다
const old1 = (await ok("POST", "/v1/pair", {}, B.token)).code;
const kept = (await ok("POST", "/v1/pair", {}, B.token)).code;
assert.equal((await call("POST", "/v1/devices", { name: "옛 코드", pair_code: old1 })).status, 403);

// 끊긴 토큰 거절, 끊긴 기기가 미리 만든 짝 코드도 거절
await ok("DELETE", `/v1/devices/${B.device_id}`, undefined, A.token);
for (const [m, p] of [["POST", "/v1/sync"], ["POST", "/v1/pair"], ["GET", "/v1/devices"], ["DELETE", `/v1/devices/${A.device_id}`], ["POST", "/v1/reset"]]) {
  assert.equal((await call(m, p, m === "POST" ? { since: 0 } : undefined, B.token)).status, 401, `${m} ${p}`);
}
assert.equal((await call("POST", "/v1/devices", { name: "도둑", pair_code: kept })).status, 403, "끊긴 기기의 짝 코드");

// 한 번에 20개까지
assert.equal((await call("POST", "/v1/sync", { since: 0, push: Array.from({ length: 21 }, (_, i) => rec("todo", `${run}-${i}`, now)) }, A.token)).status, 413);

// 기기 이름: 동기화할 때 같이 보내면 고쳐지고, 안 보내면 그대로다(옛 앱)
{
  const names = async () => Object.fromEntries((await ok("GET", "/v1/devices", undefined, A.token)).devices.map((d) => [d.id, d.name]));
  assert.equal((await names())[A.device_id], "맥");
  await ok("POST", "/v1/sync", { since: 0, push: [], name: "  다희의 MacBook Air  " }, A.token);
  assert.equal((await names())[A.device_id], "다희의 MacBook Air");
  await sync(A.token, 0);
  await ok("POST", "/v1/sync", { since: 0, push: [], name: "   " }, A.token);
  assert.equal((await names())[A.device_id], "다희의 MacBook Air", "안 보내거나 비면 그대로");
}

// 산책: 한 번에 한 기기만. 그사이 다른 기기가 나갔으면(내가 아는 지난 산책이 낡았으면) 진다
{
  const C = await ok("POST", "/v1/devices", { name: "산책 2", pair_code: (await ok("POST", "/v1/pair", {}, A.token)).code });
  const known = (await sync(A.token, 0)).walk?.start ?? 0;
  const t0 = Date.now() - 2 * 3600_000; // 두 시간 전에 나가 30분 걷고 온 산책
  let w = await ok("POST", "/v1/walk/claim", { start: t0, end: t0 + 1800_000, prev: known }, A.token);
  assert.equal(w.ok, true);
  assert.deepEqual(w.walk, { start: t0, end: t0 + 1800_000, device: A.device_id });
  assert.deepEqual((await sync(C.token, 0)).walk, w.walk, "다른 기기는 동기화 응답으로 안다");
  // 같은 지난 산책을 보고 둘이 동시에 나가려 한다: 먼저 온 쪽만 된다
  const t1 = Date.now();
  const [x, y] = await Promise.all([A, C].map((d) => ok("POST", "/v1/walk/claim", { start: t1, end: t1 + 1800_000, prev: t0 }, d.token)));
  assert.equal([x.ok, y.ok].filter(Boolean).length, 1, "둘 중 하나만");
  const winner = x.ok ? A : C, loser = x.ok ? C : A;
  // 산책 중엔 지난 산책을 제대로 알아도 못 나간다
  assert.equal((await ok("POST", "/v1/walk/claim", { start: t1 + 5, end: t1 + 1800_000, prev: t1 }, loser.token)).ok, false);
  // 끝 시각은 나간 기기만 고친다(서둘러 돌아옴). 끝나면 다음 기기가 나갈 수 있다
  assert.equal((await ok("POST", "/v1/walk/end", { start: t1, end: t1 + 1 }, loser.token)).walk.end, t1 + 1800_000);
  assert.equal((await ok("POST", "/v1/walk/end", { start: t1, end: t1 + 1 }, winner.token)).walk.end, t1 + 1);
  assert.equal((await ok("POST", "/v1/walk/claim", { start: t1 + 10, end: t1 + 20, prev: t1 }, loser.token)).ok, true);
  // 터무니없는 값은 거절
  assert.equal((await call("POST", "/v1/walk/claim", { start: t1, end: t1 + 99 * 3600_000, prev: 0 }, A.token)).status, 400);
  assert.equal((await call("POST", "/v1/walk/claim", { start: "x", end: 1, prev: 0 }, A.token)).status, 400);
  await ok("DELETE", `/v1/devices/${C.device_id}`, undefined, A.token);
}

// 열쇠 바꾸기(reset): 기록을 비우고, 그 전 순번에서 멈춘 기기는 처음부터 다시 받으라고(reset) 듣는다
const before = (await sync(A.token, 0)).seq;
const oldCode = (await ok("POST", "/v1/pair", {}, A.token)).code; // 옛 열쇠가 든 짝 문자열
await ok("POST", "/v1/reset", {}, A.token);
assert.equal((await call("POST", "/v1/devices", { name: "옛 짝", pair_code: oldCode })).status, 403, "reset 뒤 옛 짝 코드는 죽는다");
const c2 = (await ok("POST", "/v1/pair", {}, A.token)).code;
await ok("DELETE", "/v1/pair", undefined, A.token);
assert.equal((await call("POST", "/v1/devices", { name: "무효", pair_code: c2 })).status, 403, "DELETE /v1/pair 는 짝 코드를 다 지운다");
r = await sync(A.token, before);
assert.equal(r.reset, true);
r = await sync(A.token, 0);
assert.ok(!find(r, "memory", `k-${run}`), "기록이 비었다");

// 다시 맞추기: 머리(본문 없음)를 번호 순으로 나눠 받고, 고른 기록만 본문째 받는다. 기기 인증은 sync 와 같다
{
  assert.equal((await call("POST", "/v1/heads", {}, "nope")).status, 401);
  assert.equal((await call("POST", "/v1/fetch", { keys: [] }, "nope")).status, 401);
  const hs = `hs-${run}`, hm = `hm-${run}`, t = Date.now();
  const gone = `hg-${run}`;
  await sync(A.token, 0, [rec("session", hs, t), rec("msg", hm, t + 1, { parent: hs }), rec("session", gone, t, { deleted: 1, blob: null })]);
  const all = [];
  let after = null, pages = 0;
  do { const h = await ok("POST", "/v1/heads", { after }, A.token); all.push(...h.heads); after = h.next; pages++; } while (after && pages < 100);
  const mine = all.find((x) => x.coll === "msg" && x.id === hm);
  assert.ok(mine && mine.parent === hs && mine.ts === t + 1 && mine.device === A.device_id && mine.deleted === 0, "머리에 번호·세션·시각·기기");
  assert.ok(all.some((x) => x.coll === "session" && x.id === gone && x.deleted === 1), "지움 표시도 머리에");
  assert.ok(all.every((x) => !("blob" in x)), "머리엔 본문이 없다");
  const sorted = [...all].sort((x, y) => (x.coll < y.coll ? -1 : x.coll > y.coll ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  assert.deepEqual(all.map((x) => `${x.coll}/${x.id}`), sorted.map((x) => `${x.coll}/${x.id}`), "(coll, id) 순");
  const f = await ok("POST", "/v1/fetch", { keys: [["msg", hm], ["msg", "없는-번호"], ["session", hs]] }, A.token);
  assert.deepEqual(f.records.map((x) => x.id).sort(), [hm, hs].sort());
  assert.ok(f.records.every((x) => typeof x.blob === "string"), "고른 기록은 본문째");
  assert.deepEqual(f.rest, []);
  assert.equal((await call("POST", "/v1/fetch", { keys: Array.from({ length: 51 }, (_, i) => ["msg", `x${i}`]) }, A.token)).status, 413);
}

console.log("server sync ok");
