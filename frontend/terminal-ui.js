import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { renderPet } from "./pet-renderer.js";

const { createElement } = React;

const APP_BG = "#111315";
const SURFACE_BG = "#15181b";
const SURFACE_BG_ALT = "#191d21";
const FOOTER_BG = "#13161a";
const OVERLAY_BG = "#0d0f12";

const VIEWS = ["chat", "memo", "todo", "schedule", "github"];

export async function runTerminalApp(controller) {
  render(createElement(NekoDeskApp, { controller }));
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

function NekoDeskApp({ controller }) {
  const { exit } = useApp();
  const [viewModel, setViewModel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activeView, setActiveView] = useState("chat");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const mountedRef = useRef(true);

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
        { role: "system", text: "NekoDesk ready. Press `/` to open the command palette." },
        { role: "assistant", text: initialViewModel.lastReply }
      ]);
    });

    const timer = setInterval(() => {
      if (mountedRef.current) {
        setTick((current) => current + 1);
      }
    }, 900);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [controller]);

  const paletteCommands = useMemo(() => buildPaletteCommands(), []);
  const filteredCommands = useMemo(
    () => filterPaletteCommands(paletteCommands, paletteQuery),
    [paletteCommands, paletteQuery]
  );
  const tabs = useMemo(() => buildViewTabs(activeView), [activeView]);

  useEffect(() => {
    if (paletteIndex >= filteredCommands.length) {
      setPaletteIndex(0);
    }
  }, [filteredCommands.length, paletteIndex]);

  useInput(async (value, key) => {
    if (!viewModel) {
      return;
    }

    if (paletteOpen) {
      await handlePaletteInput({
        value,
        key,
        filteredCommands,
        paletteIndex,
        onClose: () => {
          setPaletteOpen(false);
          setPaletteQuery("");
          setPaletteIndex(0);
        },
        onMove: (delta) => {
          if (!filteredCommands.length) {
            return;
          }
          setPaletteIndex((current) => {
            const next = current + delta;
            if (next < 0) {
              return filteredCommands.length - 1;
            }
            if (next >= filteredCommands.length) {
              return 0;
            }
            return next;
          });
        },
        onQuery: setPaletteQuery,
        query: paletteQuery,
        onSelect: async (command) => {
          setPaletteOpen(false);
          setPaletteQuery("");
          setPaletteIndex(0);
          await executePaletteCommand(command);
        }
      });
      return;
    }

    if (busy) {
      return;
    }

    if (value === "/" && !inputValue) {
      setPaletteOpen(true);
      setPaletteQuery("");
      setPaletteIndex(0);
      return;
    }

    if (key.return) {
      const submitted = inputValue.trim();
      if (!submitted) {
        return;
      }

      await submitPrompt(submitted);
      return;
    }

    if (key.backspace || key.delete) {
      setInputValue((current) => current.slice(0, -1));
      return;
    }

    if (key.escape) {
      exit();
      return;
    }

    if (!key.ctrl && !key.meta && value) {
      setInputValue((current) => current + value);
    }
  });

  async function executePaletteCommand(command) {
    if (command.kind === "view") {
      setActiveView(command.targetView);
      const nextViewModel = await controller.getViewModel({ activeView: command.targetView });
      if (mountedRef.current) {
        setViewModel(nextViewModel);
      }
      return;
    }

    if (command.action === "help") {
      await submitPrompt("help", { recordAsUser: false });
      return;
    }

    if (command.action === "exit") {
      await submitPrompt("exit", { recordAsUser: false });
    }
  }

  async function submitPrompt(submitted, options = {}) {
    const { recordAsUser = true } = options;

    if (recordAsUser) {
      setMessages((current) => [...current, { role: "user", text: submitted }]);
    } else {
      setMessages((current) => [...current, { role: "system", text: submitted }]);
    }

    setInputValue("");
    setBusy(true);

    try {
      const result = await controller.handleInput(submitted, { activeView });
      const nextViewModel = await controller.getViewModel({ activeView });

      if (!mountedRef.current) {
        return;
      }

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

  if (!viewModel) {
    return createElement(
      Box,
      { flexDirection: "column", padding: 1, backgroundColor: APP_BG },
      createElement(Text, { color: "cyanBright", bold: true }, "NekoDesk"),
      createElement(Text, { color: "gray" }, "Loading terminal workspace...")
    );
  }

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, backgroundColor: APP_BG },
    createElement(Header, {
      petMood: viewModel.petMood,
      busy,
      githubReady: !viewModel.panels.github.lines.includes("GitHub token not configured."),
      llmEndpoint: viewModel.meta.llmEndpoint
    }),
    createElement(TabStrip, { tabs }),
    createElement(
      Box,
      { flexDirection: "row", marginTop: 1, backgroundColor: APP_BG },
      createElement(
        Box,
        { width: 24, flexShrink: 0, paddingRight: 1, backgroundColor: APP_BG },
        createElement(PetPanel, { viewModel, tick })
      ),
      createElement(
        Box,
        { flexGrow: 1, backgroundColor: APP_BG },
        createElement(MainPanel, {
          activeView,
          panels: viewModel.panels,
          messages
        })
      )
    ),
    createElement(InputPanel, { inputValue, busy }),
    paletteOpen
      ? createElement(CommandPaletteOverlay, {
          commands: filteredCommands,
          paletteIndex,
          paletteQuery
        })
      : null
  );
}

async function handlePaletteInput({
  value,
  key,
  filteredCommands,
  paletteIndex,
  onClose,
  onMove,
  onQuery,
  query,
  onSelect
}) {
  if (key.escape) {
    onClose();
    return;
  }

  if (key.upArrow) {
    onMove(-1);
    return;
  }

  if (key.downArrow) {
    onMove(1);
    return;
  }

  if (key.return) {
    if (!filteredCommands.length) {
      onClose();
      return;
    }
    await onSelect(filteredCommands[Math.min(filteredCommands.length - 1, paletteIndex)]);
    return;
  }

  if (key.backspace || key.delete) {
    if (!query) {
      onClose();
      return;
    }
    onQuery(query.slice(0, -1));
    return;
  }

  if (!key.ctrl && !key.meta && value) {
    onQuery(`${query}${value}`);
  }
}

function Header({ petMood, busy, githubReady, llmEndpoint }) {
  return createElement(
    Box,
    { justifyContent: "space-between", paddingX: 1, paddingY: 0, backgroundColor: SURFACE_BG },
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
    { flexDirection: "row", marginTop: 1, paddingX: 1, backgroundColor: SURFACE_BG },
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

function PetPanel({ viewModel, tick }) {
  const petLines = renderPet(viewModel.petMood, tick).split("\n");

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG, minHeight: 15 },
    createElement(SectionLabel, { title: "pet", color: "magentaBright" }),
    ...petLines.map((line, index) =>
      createElement(Text, { key: `pet-${index}`, color: "white" }, line)
    ),
    createElement(Text, { color: "gray" }, `mood    ${viewModel.petMood}`),
    createElement(Text, { color: "gray", dimColor: true }, `say     ${viewModel.lastReply}`)
  );
}

function MainPanel({ activeView, panels, messages }) {
  if (activeView === "chat") {
    return createElement(ChatPanel, { messages });
  }

  return createElement(ListPanel, {
    title: activeView,
    lines: panels[activeView]?.lines || ["(empty)"]
  });
}

function ChatPanel({ messages }) {
  const visibleMessages = messages.slice(-12);

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG_ALT, minHeight: 15 },
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

function ListPanel({ title, lines }) {
  const visibleLines = lines.slice(0, 12);

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG_ALT, minHeight: 15 },
    createElement(SectionLabel, { title, color: "cyanBright" }),
    createElement(
      Box,
      { flexDirection: "column", marginTop: 1 },
      ...visibleLines.map((line, index) =>
        createElement(Text, { key: `${title}-${index}`, color: "white" }, line)
      )
    )
  );
}

function InputPanel({ inputValue, busy }) {
  return createElement(
    Box,
    { flexDirection: "column", marginTop: 1, paddingX: 1, paddingY: 1, backgroundColor: FOOTER_BG },
    createElement(SectionLabel, { title: "prompt", color: "gray" }),
    createElement(Text, { color: busy ? "yellow" : "greenBright" }, `› ${inputValue}${busy ? "" : "█"}`),
    createElement(Text, { color: "gray" }, busy ? "Thinking..." : "Enter to submit · Esc to quit"),
    createElement(Text, { color: "gray", dimColor: true }, "/ opens command palette · help · exit")
  );
}

function CommandPaletteOverlay({ commands, paletteIndex, paletteQuery }) {
  return createElement(
    Box,
    {
      position: "absolute",
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: OVERLAY_BG
    },
    createElement(
      Box,
      { flexDirection: "column", width: "70%", paddingX: 2, paddingY: 1, backgroundColor: SURFACE_BG_ALT },
      createElement(Text, { color: "white", bold: true }, "command"),
      createElement(Text, { color: "gray" }, `/${paletteQuery}`),
      createElement(Text, { color: "gray", dimColor: true }, "Use arrows and Enter to navigate"),
      createElement(
        Box,
        { flexDirection: "column", marginTop: 1 },
        ...(commands.length
          ? commands.map((command, index) =>
              createElement(
                Box,
                { key: command.id, flexDirection: "row", justifyContent: "space-between" },
                createElement(
                  Text,
                  { color: index === paletteIndex ? "cyanBright" : "white", bold: index === paletteIndex },
                  command.label
                ),
                createElement(Text, { color: "gray" }, command.description)
              )
            )
          : [createElement(Text, { key: "empty", color: "gray" }, "No matching commands")])
      )
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
