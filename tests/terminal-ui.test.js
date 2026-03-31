import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaletteCommands,
  buildViewTabs,
  calculateResponsiveLayout,
  filterPaletteCommands
} from "../frontend/terminal-ui.js";

test("buildPaletteCommands exposes routes and actions", () => {
  const commands = buildPaletteCommands();
  assert.deepEqual(commands.map((command) => command.label), [
    "/chat",
    "/memo",
    "/todo",
    "/schedule",
    "/github",
    "/refresh",
    "/help",
    "/exit"
  ]);
});

test("filterPaletteCommands narrows results by query", () => {
  const commands = buildPaletteCommands();
  const filtered = filterPaletteCommands(commands, "git");
  assert.deepEqual(filtered.map((command) => command.label), ["/github"]);
});

test("buildViewTabs marks the active view", () => {
  const tabs = buildViewTabs("todo");
  assert.equal(tabs.find((tab) => tab.id === "todo").active, true);
  assert.equal(tabs.find((tab) => tab.id === "chat").active, false);
});

test("calculateResponsiveLayout adapts for narrow terminals", () => {
  const narrow = calculateResponsiveLayout(80, 24);
  const wide = calculateResponsiveLayout(140, 40);

  assert.equal(narrow.stacked, true);
  assert.equal(wide.stacked, false);
  assert.ok(narrow.paletteWidth < wide.paletteWidth);
  assert.ok(narrow.chatMessageLimit <= wide.chatMessageLimit);
});

test("calculateResponsiveLayout flags unsupported terminal sizes", () => {
  const tiny = calculateResponsiveLayout(60, 18);
  const safe = calculateResponsiveLayout(100, 30);

  assert.equal(tiny.tooSmall, true);
  assert.equal(safe.tooSmall, false);
  assert.ok(safe.bodyHeight > tiny.bodyHeight);
});
