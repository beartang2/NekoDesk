-- 짝 코드에 만든 기기를 적는다. 끊긴 기기(잃어버린 폰)가 미리 만든 코드로 새 기기를 등록하지 못하게,
-- 등록할 때 만든 기기가 아직 살아 있는지 보고, 끊을 때 그 기기의 코드를 지운다.
-- 이전 코드(만든 기기 모름)는 쓸 수 없게 비운다 — 10분짜리라 잃을 게 없다.
DELETE FROM pair_codes;
ALTER TABLE pair_codes ADD COLUMN creator TEXT NOT NULL DEFAULT '';
CREATE INDEX pair_codes_creator ON pair_codes (creator);
