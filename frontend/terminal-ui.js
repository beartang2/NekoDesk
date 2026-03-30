import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { renderPet } from "./pet-renderer.js";

export async function runTerminalApp(controller) {
  const rl = readline.createInterface({ input, output });
  let tick = 0;

  output.write("\x1b[2J\x1b[H");

  try {
    while (true) {
      const view = await controller.getViewModel();
      renderScreen(view, tick++);
      const answer = await rl.question("\n> ");
      const result = await controller.handleInput(answer);
      const nextView = await controller.getViewModel();
      renderScreen({ ...nextView, lastReply: result.reply, petMood: result.petMood }, tick++);
      if (result.shouldExit) {
        break;
      }
    }
  } finally {
    rl.close();
  }
}

function renderScreen(view, tick) {
  const pet = renderPet(view.petMood, tick).split("\n");
  const memoBox = createBox("Memo", view.dashboard.memos, 42, 6);
  const todoBox = createBox("Todo", view.dashboard.todos, 42, 8);
  const eventBox = createBox("Schedule", view.dashboard.events, 42, 6);
  const githubBox = createBox("GitHub", view.dashboard.github, 42, 6);
  const infoBox = createBox("Neko", [view.lastReply, ...view.hints], 88, 6);

  const leftBox = combineLines(pet, ["", "상태: " + view.petMood]);
  const rightTop = mergeColumns(memoBox, todoBox, 2);
  const rightBottom = mergeColumns(eventBox, githubBox, 2);
  const top = mergeColumns(leftBox, rightTop, 4);
  const all = [...top, "", ...rightBottom, "", ...infoBox];

  output.write("\x1b[H");
  output.write(`${all.join("\n")}\n`);
}

function createBox(title, lines, width, height) {
  const normalized = lines.length ? lines : ["(empty)"];
  const body = normalized.slice(0, height).map((line) => truncate(line, width - 4));
  while (body.length < height) {
    body.push("");
  }

  return [
    `┌${"─".repeat(width - 2)}┐`,
    `│ ${pad(`${title}`, width - 4)} │`,
    `├${"─".repeat(width - 2)}┤`,
    ...body.map((line) => `│ ${pad(line, width - 4)} │`),
    `└${"─".repeat(width - 2)}┘`
  ];
}

function mergeColumns(left, right, gap) {
  const rows = Math.max(left.length, right.length);
  const width = Math.max(...left.map((line) => line.length));
  const lines = [];

  for (let index = 0; index < rows; index += 1) {
    const leftLine = left[index] || "";
    const rightLine = right[index] || "";
    lines.push(`${pad(leftLine, width)}${" ".repeat(gap)}${rightLine}`);
  }

  return lines;
}

function combineLines(...groups) {
  return groups.flatMap((group) => group);
}

function truncate(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function pad(text, width) {
  return text.padEnd(width, " ");
}
