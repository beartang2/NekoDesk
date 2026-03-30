#!/usr/bin/env node

import { createAppController } from "../backend/app-controller.js";
import { runTerminalApp } from "../frontend/terminal-ui.js";

async function main() {
  const controller = await createAppController();
  const onceArgs = process.argv.slice(2);

  if (onceArgs[0] === "--once") {
    const input = onceArgs.slice(1).join(" ").trim();
    const result = await controller.handleInput(input || "도움말");
    process.stdout.write(`${result.reply}\n`);
    return;
  }

  await runTerminalApp(controller);
}

main().catch((error) => {
  process.stderr.write(`NekoDesk failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
