import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaletteCommands,
  buildViewTabs,
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
