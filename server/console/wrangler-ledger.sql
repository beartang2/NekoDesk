-- (골라서) 대시보드 Console 로 0001·0002 를 붙여 만든 D1 에, wrangler 가 "이미 적용했다"고 알게 하는 기록.
-- 나중에 `npm run migrate:remote`(wrangler)로 바꾸고 싶을 때만 한 번 붙인다. 안 붙이면 wrangler 는 0001 부터
-- 다시 하려다 "table already exists" 로 멈춘다. 대시보드로만 계속 할 거면 필요 없다.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql'), ('0002_pair_creator.sql');
