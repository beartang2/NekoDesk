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

// 끊긴 토큰 거절
await ok("DELETE", `/v1/devices/${B.device_id}`, undefined, A.token);
assert.equal((await call("POST", "/v1/sync", { since: 0 }, B.token)).status, 401);

// 한 번에 20개까지
assert.equal((await call("POST", "/v1/sync", { since: 0, push: Array.from({ length: 21 }, (_, i) => rec("todo", `${run}-${i}`, now)) }, A.token)).status, 413);

console.log("server sync ok");
