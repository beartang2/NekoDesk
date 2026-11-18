-- 네코 동기화 서버 D1 스키마 (docs/neko-sync.md §4.3). 서버는 blob(암호문)을 못 읽는다.
-- 산책(walks)·서버 장부는 4단계에서 다음 마이그레이션으로 더한다.

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,         -- SHA-256(토큰) hex. 토큰 자체는 안 둔다
  created_at INTEGER NOT NULL,
  last_seen INTEGER,                        -- 마지막 요청
  last_active INTEGER,                      -- 사용자가 마지막으로 앱을 만진 때(active_at)
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pair_codes (code_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);

-- 기록 하나 = 기기 쪽 항목 하나. deleted=1 은 지움 표시. session 의 cut:
--   살아 있는 세션이면 "이 ts 까지의 메시지는 지워졌다"(수동 요약),
--   지움 표시면 자동 삭제(prune)의 기준 시각이다 — 사용자가 지운 것은 cut 이 비어 있다.
CREATE TABLE records (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  parent TEXT,
  ts INTEGER NOT NULL,
  device TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  cut INTEGER,
  blob TEXT,                                -- base64(nonce 24 + 암호문)
  seq INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE INDEX records_seq ON records (seq);
CREATE INDEX records_parent ON records (parent, ts);

-- seq: 마지막으로 매긴 순번. purged_seq: 이보다 앞에서 멈춘 기기는 처음부터 다시 받는다(reset).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta (key, value) VALUES ('seq', '0'), ('purged_seq', '0');
