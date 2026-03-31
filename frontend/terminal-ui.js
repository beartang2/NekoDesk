import React, { useEffect, useMemo, useRef, useState } from "react";
import { createInterface, clearLine, cursorTo } from "node:readline";
import { Box, Text, render, useApp, useInput } from "ink";
import { renderPet } from "./pet-renderer.js";

const { createElement } = React;

const APP_BG = "#111315";
const SURFACE_BG = "#15181b";
const SURFACE_BG_ALT = "#191d21";
const FOOTER_BG = "#13161a";
const MIN_COLUMNS = 72;
const MIN_ROWS = 22;
const INPUT_PANEL_HEIGHT = 2;
const INPUT_STACK_OFFSET = INPUT_PANEL_HEIGHT;

const VIEWS = ["chat", "memo", "todo", "schedule", "github"];

export async function runTerminalApp(controller) {
  const stdout = process.stdout;
  const restoreTerminal = stdout.isTTY ? enterAlternateScreen(stdout) : () => {};
  const app = render(createElement(NekoDeskApp, { controller }));

  const cleanup = once(() => {
    restoreTerminal();
  });

  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  try {
    await app.waitUntilExit();
  } finally {
    process.off("exit", cleanup);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    cleanup();
  }
}

export function buildPaletteCommands() {
  return [
    { id: "/chat", label: "/chat", kind: "view", targetView: "chat", description: "Switch to chat view" },
    { id: "/memo", label: "/memo", kind: "view", targetView: "memo", description: "Switch to memo view" },
    { id: "/todo", label: "/todo", kind: "view", targetView: "todo", description: "Switch to todo view" },
    {
      id: "/schedule",
      label: "/schedule",
      kind: "view",
      targetView: "schedule",
      description: "Switch to schedule view"
    },
    {
      id: "/github",
      label: "/github",
      kind: "view",
      targetView: "github",
      description: "Switch to GitHub view"
    },
    { id: "/refresh", label: "/refresh", kind: "action", action: "refresh", description: "Refresh dashboard" },
    { id: "/help", label: "/help", kind: "action", action: "help", description: "Show usage help" },
    { id: "/exit", label: "/exit", kind: "action", action: "exit", description: "Exit NekoDesk" }
  ];
}

export function filterPaletteCommands(commands, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return commands;
  }

  return commands.filter((command) =>
    [command.label, command.description, command.targetView, command.action]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(normalized))
  );
}

export function buildViewTabs(activeView) {
  return VIEWS.map((view) => ({
    id: view,
    label: view,
    active: view === activeView
  }));
}

export function calculateResponsiveLayout(columns = 120, rows = 30) {
  const safeColumns = Number.isFinite(columns) ? columns : 120;
  const safeRows = Number.isFinite(rows) ? rows : 30;
  const stacked = safeColumns < 96;
  const headerHeight = 2;
  const tabHeight = 2;
  const footerHeight = INPUT_STACK_OFFSET;
  const bodyHeight = Math.max(8, safeRows - headerHeight - tabHeight - footerHeight - 2);

  return {
    columns: safeColumns,
    rows: safeRows,
    viewportRows: Math.max(10, safeRows - INPUT_STACK_OFFSET),
    tooSmall: safeColumns < MIN_COLUMNS || safeRows < MIN_ROWS,
    stacked,
    petWidth: stacked ? Math.max(20, safeColumns - 4) : clamp(Math.floor(safeColumns * 0.24), 22, 30),
    bodyHeight,
    petMinHeight: stacked ? Math.max(10, Math.floor(bodyHeight * 0.42)) : bodyHeight,
    chatMessageLimit: clamp(bodyHeight - 3, 6, 24),
    listMaxLines: clamp(bodyHeight - 3, 6, 34),
    githubMaxLines: clamp(bodyHeight - 3, 10, 40),
    paletteWidth: clamp(Math.floor(safeColumns * 0.72), 36, 84),
    confirmationWidth: clamp(Math.floor(safeColumns * 0.48), 34, 56)
  };
}

function NekoDeskApp({ controller }) {
  const { exit } = useApp();
  const [viewModel, setViewModel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [activeView, setActiveView] = useState("chat");
  const [confirmationSelection, setConfirmationSelection] = useState("confirm");
  const mountedRef = useRef(true);
  const readlineRef = useRef(null);
  const submitPromptRef = useRef(null);
  const busyRef = useRef(false);
  const pendingConfirmationRef = useRef(false);
  const tooSmallRef = useRef(false);
  const terminalSize = useTerminalSize();
  const layout = useMemo(
    () => calculateResponsiveLayout(terminalSize.columns, terminalSize.rows),
    [terminalSize.columns, terminalSize.rows]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    controller.getViewModel({ activeView: "chat" }).then((initialViewModel) => {
      if (!active || !mountedRef.current) {
        return;
      }

      setViewModel(initialViewModel);
      setMessages([
        { role: "system", text: "NekoDesk ready. 자연어로 말해줘." },
        { role: "assistant", text: initialViewModel.lastReply }
      ]);
    });

    return () => {
      active = false;
    };
  }, [controller]);

  const tabs = useMemo(() => buildViewTabs(activeView), [activeView]);

  useEffect(() => {
    submitPromptRef.current = submitPrompt;
  });

  useEffect(() => {
    busyRef.current = busy;
    pendingConfirmationRef.current = Boolean(viewModel?.pendingConfirmation);
    tooSmallRef.current = layout.tooSmall;
  }, [busy, viewModel?.pendingConfirmation, layout.tooSmall]);

  useEffect(() => {
    if (viewModel?.pendingConfirmation) {
      setConfirmationSelection("confirm");
    }
  }, [viewModel?.pendingConfirmation]);

  useInput(
    (input, key) => {
      if (key.escape) {
        void submitConfirmation("cancel");
        return;
      }

      if (key.return) {
        void submitConfirmation(confirmationSelection);
        return;
      }

      if (key.leftArrow || key.upArrow) {
        setConfirmationSelection((current) => previousConfirmationChoice(current));
        return;
      }

      if (key.rightArrow || key.downArrow || key.tab) {
        setConfirmationSelection((current) => nextConfirmationChoice(current));
      }
    },
    {
      isActive: Boolean(viewModel?.pendingConfirmation) && !busy && !layout.tooSmall
    }
  );

  useEffect(() => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin?.isTTY || !stdout?.isTTY) {
      return undefined;
    }

    const rl = createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
      historySize: 200,
      removeHistoryDuplicates: true,
      completer: (line) =>
        completeNativeInput(line, {
          pendingConfirmation: pendingConfirmationRef.current
        })
    });

    readlineRef.current = rl;
    rl.setPrompt("› ");

    const handleLine = (line) => {
      const submitted = line.trim();

      if (
        !mountedRef.current ||
        busyRef.current ||
        tooSmallRef.current
      ) {
        return;
      }

      if (!submitted) {
        promptNativeInput(rl);
        return;
      }

      if (pendingConfirmationRef.current) {
        setMessages((current) => [
          ...current,
          { role: "system", text: "확인창에서는 방향키와 Enter, 또는 Esc를 써줘." }
        ]);
        return;
      }

      void submitPromptRef.current?.(submitted);
    };

    rl.on("line", handleLine);

    return () => {
      rl.off("line", handleLine);
      rl.close();
      readlineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const rl = readlineRef.current;
    if (!rl) {
      return;
    }

    const shouldEnableInput =
      !!viewModel &&
      !busy &&
      !viewModel.pendingConfirmation &&
      !layout.tooSmall;

    if (shouldEnableInput) {
      promptNativeInput(rl, "› ");
      return;
    }

    clearNativeInputLine();
    rl.pause();
  }, [viewModel, busy, layout.tooSmall]);

  async function submitPrompt(submitted, options = {}) {
    const { recordAsUser = true } = options;

    if (recordAsUser) {
      setMessages((current) => [...current, { role: "user", text: submitted }]);
    } else {
      setMessages((current) => [...current, { role: "system", text: submitted }]);
    }

    setBusy(true);
    pauseNativeInput(readlineRef.current);

    try {
      const result = await controller.handleInput(submitted, { activeView });
      const nextView = result.nextView || activeView;
      const nextViewModel = await controller.getViewModel({ activeView: nextView });

      if (!mountedRef.current) {
        return;
      }

      setActiveView(nextView);
      setViewModel(nextViewModel);
      setMessages((current) => [...current, { role: "assistant", text: result.reply }]);

      if (result.shouldExit) {
        exit();
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }

  async function submitConfirmation(action) {
    setBusy(true);
    pauseNativeInput(readlineRef.current);

    try {
      const result = await controller.resolveConfirmation(action);
      const nextView = result.nextView || activeView;
      const nextViewModel = await controller.getViewModel({ activeView: nextView });

      if (!mountedRef.current) {
        return;
      }

      setActiveView(nextView);
      setViewModel(nextViewModel);
      setMessages((current) => [
        ...current,
        { role: "system", text: action === "confirm" ? "[confirm]" : "[cancel]" },
        { role: "assistant", text: result.reply }
      ]);

      if (result.shouldExit) {
        exit();
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }

  if (!viewModel) {
    return createElement(
      Box,
      { flexDirection: "column", padding: 1, height: layout.viewportRows, backgroundColor: APP_BG },
      createElement(Text, { color: "cyanBright", bold: true }, "NekoDesk"),
      createElement(Text, { color: "gray" }, "Loading terminal workspace...")
    );
  }

  if (layout.tooSmall) {
    return createElement(ResizeScreen, { layout });
  }

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, height: layout.viewportRows, backgroundColor: APP_BG },
    createElement(Header, {
      petMood: viewModel.petMood,
      busy,
      githubReady: !viewModel.panels.github.lines.includes("GitHub token not configured."),
      llmEndpoint: viewModel.meta.llmEndpoint
    }),
    createElement(TabStrip, { tabs }),
    createElement(
      Box,
      {
        flexDirection: layout.stacked ? "column" : "row",
        marginTop: 1,
        flexGrow: 1,
        backgroundColor: APP_BG
      },
      createElement(
        Box,
        {
          width: layout.stacked ? "100%" : layout.petWidth,
          height: layout.stacked ? layout.petMinHeight : layout.bodyHeight,
          flexShrink: 0,
          paddingRight: layout.stacked ? 0 : 1,
          marginBottom: layout.stacked ? 1 : 0,
          backgroundColor: APP_BG
        },
        createElement(PetPanel, {
          viewModel,
          tick: busy ? 1 : 0,
          minHeight: layout.petMinHeight
        })
      ),
      createElement(
        Box,
        {
          flexGrow: 1,
          height: layout.stacked ? Math.max(8, layout.bodyHeight - layout.petMinHeight - 1) : layout.bodyHeight,
          backgroundColor: APP_BG
        },
        createElement(MainPanel, {
          activeView,
          panels: viewModel.panels,
          messages,
          chatMessageLimit: layout.chatMessageLimit,
          listMaxLines: layout.listMaxLines,
          githubMaxLines: layout.githubMaxLines
        })
      )
    ),
    createElement(FooterStatus, { busy }),
    viewModel.pendingConfirmation
      ? createElement(ConfirmationOverlay, {
          message: viewModel.pendingConfirmation.message,
          width: layout.confirmationWidth,
          selection: confirmationSelection
        })
      : null
  );
}

function Header({ petMood, busy, githubReady, llmEndpoint }) {
  return createElement(
    Box,
    { justifyContent: "space-between", paddingX: 1, paddingY: 0, height: 2, backgroundColor: SURFACE_BG },
    createElement(
      Box,
      { flexDirection: "column" },
      createElement(Text, { color: "cyanBright", bold: true }, "NekoDesk"),
      createElement(Text, { color: "gray" }, "terminal pet dashboard")
    ),
    createElement(
      Box,
      { flexDirection: "column", alignItems: "flex-end" },
      createElement(Text, { color: moodColor(petMood) }, `mood ${petMood}${busy ? " · working" : ""}`),
      createElement(
        Text,
        { color: "gray" },
        `llm ${llmEndpoint} · github ${githubReady ? "ready" : "token missing"}`
      )
    )
  );
}

function TabStrip({ tabs }) {
  return createElement(
    Box,
    { flexDirection: "row", marginTop: 1, paddingX: 1, height: 2, backgroundColor: SURFACE_BG },
    ...tabs.map((tab) =>
      createElement(
        Box,
        { key: tab.id, marginRight: 2 },
        createElement(
          Text,
          {
            color: tab.active ? "white" : "gray",
            bold: tab.active
          },
          tab.active ? `[${tab.label}]` : tab.label
        )
      )
    )
  );
}

function PetPanel({ viewModel, tick, minHeight }) {
  const petLines = renderPet(viewModel.petMood, tick).split("\n");

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG, minHeight },
    createElement(SectionLabel, { title: "pet", color: "magentaBright" }),
    ...petLines.map((line, index) =>
      createElement(Text, { key: `pet-${index}`, color: "white" }, line)
    ),
    createElement(Text, { color: "gray" }, `mood    ${viewModel.petMood}`),
    createElement(Text, { color: "gray", dimColor: true }, `say     ${viewModel.lastReply}`)
  );
}

function MainPanel({ activeView, panels, messages, chatMessageLimit, listMaxLines, githubMaxLines }) {
  if (activeView === "chat") {
    return createElement(ChatPanel, { messages, maxMessages: chatMessageLimit });
  }

  return createElement(ListPanel, {
    title: activeView,
    lines: panels[activeView]?.lines || ["(empty)"],
    maxLines: activeView === "github" ? githubMaxLines : listMaxLines
  });
}

function ChatPanel({ messages, maxMessages = 12 }) {
  const visibleMessages = messages.slice(-maxMessages);

  return createElement(
    Box,
    { flexDirection: "column", flexGrow: 1, height: "100%", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG_ALT },
    createElement(SectionLabel, { title: "conversation", color: "cyanBright" }),
    createElement(
      Box,
      { flexDirection: "column", marginTop: 1 },
      ...visibleMessages.map((message, index) =>
        createElement(LogMessage, { key: `${message.role}-${index}`, message })
      )
    )
  );
}

function ListPanel({ title, lines, maxLines = 12 }) {
  const visibleLines = lines.slice(0, maxLines);

  return createElement(
    Box,
    { flexDirection: "column", flexGrow: 1, height: "100%", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG_ALT },
    createElement(SectionLabel, { title, color: "cyanBright" }),
    createElement(
      Box,
      { flexDirection: "column", marginTop: 1 },
      ...visibleLines.map((line, index) =>
        createElement(
          Text,
          {
            key: `${title}-${index}`,
            color: isSectionHeader(line) ? "gray" : "white",
            dimColor: isSectionHeader(line)
          },
          line
        )
      )
    )
  );
}

function isSectionHeader(line) {
  return typeof line === "string" && !!line && !line.startsWith(" ") && !line.includes(":");
}

function ConfirmationOverlay({ message, width, selection }) {
  return createElement(
    Box,
    {
      position: "absolute",
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center"
    },
    createElement(
      Box,
      { flexDirection: "column", width, paddingX: 2, paddingY: 1 },
      createElement(Text, { color: "yellowBright", bold: true }, "confirm"),
      createElement(Text, { color: "white" }, message),
      createElement(
        Box,
        { flexDirection: "row", marginTop: 1 },
        createElement(ConfirmationOption, {
          label: "확인",
          active: selection === "confirm"
        }),
        createElement(Box, { width: 2 }),
        createElement(ConfirmationOption, {
          label: "취소",
          active: selection === "cancel"
        })
      ),
      createElement(
        Text,
        { color: "gray", dimColor: true },
        "←/→ 또는 Tab으로 선택 · Enter 확인 · Esc 취소"
      )
    )
  );
}

function FooterStatus({ busy }) {
  return createElement(
    Box,
    {
      height: 1,
      marginTop: 1,
      paddingX: 1,
      justifyContent: "flex-start",
      backgroundColor: FOOTER_BG
    },
    createElement(
      Text,
      { color: busy ? "yellowBright" : "gray", dimColor: !busy },
      busy ? "Thinking..." : "Ready"
    )
  );
}

function ConfirmationOption({ label, active }) {
  return createElement(
    Text,
    {
      color: active ? "black" : "gray",
      backgroundColor: active ? "yellow" : undefined,
      bold: active
    },
    active ? ` ${label} ` : label
  );
}

function ResizeScreen({ layout }) {
  return createElement(
    Box,
    {
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      height: layout.viewportRows,
      paddingX: 2,
      backgroundColor: APP_BG
    },
    createElement(Text, { color: "cyanBright", bold: true }, "NekoDesk"),
    createElement(Text, { color: "white" }, "터미널 창을 조금만 더 키워줘."),
    createElement(
      Text,
      { color: "gray" },
      `현재 ${layout.columns}x${layout.rows} · 최소 ${MIN_COLUMNS}x${MIN_ROWS}`
    )
  );
}

function LogMessage({ message }) {
  return createElement(
    Box,
    { flexDirection: "row", marginBottom: 1 },
    createElement(
      Box,
      { width: 9, flexShrink: 0 },
      createElement(Text, { color: roleColor(message.role), bold: message.role !== "system" }, roleLabel(message.role))
    ),
    createElement(
      Box,
      { flexDirection: "column" },
      ...message.text.split("\n").map((line, index) =>
        createElement(
          Text,
          { key: `${message.role}-${index}`, color: message.role === "system" ? "gray" : "white" },
          line
        )
      )
    )
  );
}

function SectionLabel({ title, color }) {
  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, { color, bold: true }, title),
    createElement(Text, { color, dimColor: true }, "-".repeat(12))
  );
}

function roleLabel(role) {
  switch (role) {
    case "user":
      return "you";
    case "assistant":
      return "neko";
    default:
      return "system";
  }
}

function roleColor(role) {
  switch (role) {
    case "user":
      return "greenBright";
    case "assistant":
      return "cyanBright";
    default:
      return "gray";
  }
}

function moodColor(mood) {
  switch (mood) {
    case "happy":
      return "greenBright";
    case "working":
      return "yellowBright";
    case "error":
      return "redBright";
    case "hungry":
      return "magentaBright";
    default:
      return "cyan";
  }
}

function enterAlternateScreen(stream) {
  stream.write("\u001B[?1049h\u001B[2J\u001B[H\u001B[?25h");

  return () => {
    stream.write("\u001B[?25h\u001B[?1049l");
  };
}

function once(fn) {
  let called = false;

  return () => {
    if (called) {
      return;
    }

    called = true;
    fn();
  };
}

function useTerminalSize() {
  const [size, setSize] = useState(() => ({
    columns: process.stdout.columns || 120,
    rows: process.stdout.rows || 30
  }));

  useEffect(() => {
    const stdout = process.stdout;
    if (!stdout?.isTTY) {
      return undefined;
    }

    const handleResize = () => {
      setSize({
        columns: stdout.columns || 120,
        rows: stdout.rows || 30
      });
    };

    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, []);

  return size;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clearNativeInputLine() {
  if (!process.stdout?.isTTY) {
    return;
  }

  clearLine(process.stdout, 0);
  cursorTo(process.stdout, 0);
}

function promptNativeInput(rl, promptLabel = "› ") {
  rl.setPrompt(promptLabel);
  rl.resume();
  clearNativeInputLine();
  rl.prompt();
}

function pauseNativeInput(rl) {
  clearNativeInputLine();
  rl?.pause();
}

function resolvePaletteCommand(input, commands) {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    commands.find((command) => command.label.toLowerCase() === normalized) ||
    commands.find((command) => command.label.toLowerCase() === `/${normalized.replace(/^\/+/, "")}`)
  );
}

function completeNativeInput(line, { pendingConfirmation }) {
  if (pendingConfirmation) {
    return [[], line];
  }

  return [[], line];
}

function nextConfirmationChoice(current) {
  return current === "confirm" ? "cancel" : "confirm";
}

function previousConfirmationChoice(current) {
  return current === "cancel" ? "confirm" : "cancel";
}

function buildCommandModeText(commands) {
  const labels = commands
    .map((command) => command.label.replace(/^\//, ""))
    .join(" · ");

  return `command mode: ${labels} · Enter empty line to cancel`;
}
