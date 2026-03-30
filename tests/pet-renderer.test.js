import test from "node:test";
import assert from "node:assert/strict";
import { renderPet } from "../frontend/pet-renderer.js";

test("renders working pet frame", () => {
  const frame = renderPet("working", 0);
  assert.match(frame, /•̀ᴗ•́/);
});

test("renders hungry pet with sad face", () => {
  const frame = renderPet("hungry", 0);
  assert.match(frame, /•́︿•̀/);
});
