import { spawn } from "node:child_process";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
const MAIN_PANEL_CHROME_ROWS = 6;
const CHAT_LABEL_WIDTH = 9;
const COLLAPSED_ASSISTANT_LINES = 5;
const VIEW_HOTKEYS = ["chat", "memo", "todo", "schedule", "github"];
const ENABLE_MOUSE_REPORTING = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE_REPORTING = "\u001b[?1000l\u001b[?1006l";
const MOUSE_INPUT_GUARD_MS = 120;

const VIEWS = ["chat", "memo", "todo", "schedule", "github"];
const GITHUB_SECTION_HEADERS = new Set([
  "account",
  "attention",
  "notifications",
  "reviews",
  "mentions",
  "work",
  "issues",
  "pull requests",
  "repos",
  "recent repos",
  "starred",
  "notes"
]);

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
    mainPanelWidth: stacked
      ? Math.max(32, safeColumns - 4)
      : Math.max(32, safeColumns - clamp(Math.floor(safeColumns * 0.24), 22, 30) - 6),
    bodyHeight,
    petMinHeight: stacked ? Math.max(10, Math.floor(bodyHeight * 0.42)) : bodyHeight,
    chatMessageLimit: clamp(bodyHeight - MAIN_PANEL_CHROME_ROWS, 4, 24),
    listMaxLines: clamp(bodyHeight - MAIN_PANEL_CHROME_ROWS, 4, 34),
    githubMaxLines: clamp(bodyHeight - MAIN_PANEL_CHROME_ROWS, 6, 40),
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
  const [chatScrollOffset, setChatScrollOffset] = useState(0);
  const [focusedMessageId, setFocusedMessageId] = useState(null);
  const [expandedMessageIds, setExpandedMessageIds] = useState(() => new Set());
  const [listScrollOffset, setListScrollOffset] = useState(0);
  const [focusedListItemId, setFocusedListItemId] = useState(null);
  const [expandedListItemIds, setExpandedListItemIds] = useState(() => new Set());
  const [inputValue, setInputValue] = useState("");
  const [inputCursor, setInputCursor] = useState(0);
  const [inputHistory, setInputHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const mountedRef = useRef(true);
  const mouseInputGuardUntilRef = useRef(0);
  const messageIdRef = useRef(1);
  const terminalSize = useTerminalSize();
  const layout = useMemo(
    () => calculateResponsiveLayout(terminalSize.columns, terminalSize.rows),
    [terminalSize.columns, terminalSize.rows]
  );
  const chatViewport = useMemo(
    () =>
      buildChatViewport(messages, {
        maxLines: Math.max(4, layout.chatMessageLimit),
        widthChars: layout.mainPanelWidth,
        scrollOffset: chatScrollOffset,
        expandedMessageIds,
        focusedMessageId
      }),
    [messages, layout.chatMessageLimit, layout.mainPanelWidth, chatScrollOffset, expandedMessageIds, focusedMessageId]
  );
  const chatMetrics = useMemo(
    () =>
      summarizeChatMessages(messages, {
        widthChars: layout.mainPanelWidth,
        expandedMessageIds
      }),
    [messages, layout.mainPanelWidth, expandedMessageIds]
  );
  const activePanelLines = useMemo(
    () => (activeView === "chat" ? [] : viewModel?.panels?.[activeView]?.lines || ["(empty)"]),
    [activeView, viewModel]
  );
  const listLineLimit = activeView === "github"
    ? Math.max(4, layout.githubMaxLines)
    : Math.max(4, layout.listMaxLines);
  const listViewport = useMemo(
    () =>
      buildListViewport(activePanelLines, {
        title: activeView,
        maxLines: listLineLimit,
        widthChars: layout.mainPanelWidth,
        scrollOffset: listScrollOffset,
        expandedItemIds: expandedListItemIds,
        focusedItemId: focusedListItemId
      }),
    [
      activePanelLines,
      activeView,
      listLineLimit,
      layout.mainPanelWidth,
      listScrollOffset,
      expandedListItemIds,
      focusedListItemId
    ]
  );
  const listMetrics = useMemo(
    () =>
      summarizeListItems(activePanelLines, {
        title: activeView,
        widthChars: layout.mainPanelWidth,
        expandedItemIds: expandedListItemIds,
        focusedItemId: focusedListItemId
      }),
    [activePanelLines, activeView, layout.mainPanelWidth, expandedListItemIds, focusedListItemId]
  );

  function attachMessageIds(items) {
    return items.map((message) => ({
      id: `chat-${messageIdRef.current += 1}`,
      role: message.role,
      text: message.text
    }));
  }

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
      setMessages(
        attachMessageIds(
          trimChatMessages(
            initialViewModel.conversation || [],
            initialViewModel.meta?.conversationMemoryLimit
          )
        )
      );
    });

    return () => {
      active = false;
    };
  }, [controller]);

  const tabs = useMemo(() => buildViewTabs(activeView), [activeView]);

  useEffect(() => {
    if (viewModel?.pendingConfirmation) {
      setConfirmationSelection("confirm");
    }
  }, [viewModel?.pendingConfirmation]);

  useEffect(() => {
    const currentMessageIds = new Set(messages.map((message) => message.id));
    const collapsibleMessageIds = chatMetrics.collapsibleMessageIds;

    setExpandedMessageIds((current) => {
      const next = new Set([...current].filter((messageId) => currentMessageIds.has(messageId)));
      return areSetsEqual(current, next) ? current : next;
    });
    setFocusedMessageId((current) => {
      if (current && collapsibleMessageIds.includes(current)) {
        return current;
      }

      return collapsibleMessageIds.at(-1) || null;
    });
    setChatScrollOffset((current) => clamp(current, 0, chatViewport.maxScrollOffset));
  }, [messages, chatMetrics.collapsibleMessageIds, chatViewport.maxScrollOffset]);

  useEffect(() => {
    if (activeView === "chat") {
      return;
    }

    const currentItemIds = new Set(listMetrics.items.map((item) => item.id));
    const collapsibleItemIds = listMetrics.collapsibleItemIds;

    setExpandedListItemIds((current) => {
      const next = new Set([...current].filter((itemId) => currentItemIds.has(itemId)));
      return areSetsEqual(current, next) ? current : next;
    });
    setFocusedListItemId((current) => {
      if (current && collapsibleItemIds.includes(current)) {
        return current;
      }

      return collapsibleItemIds[0] || null;
    });
    setListScrollOffset((current) => clamp(current, 0, listViewport.maxScrollOffset));
  }, [activeView, listMetrics.items, listMetrics.collapsibleItemIds, listViewport.maxScrollOffset]);

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

  useInput(
    (input, key) => {
      switch (resolveChatHotkey(input, key)) {
        case "toggle_expand":
          if (!focusedListItemId) {
            return;
          }

          setExpandedListItemIds((current) => {
            const next = new Set(current);
            if (next.has(focusedListItemId)) {
              next.delete(focusedListItemId);
            } else {
              next.add(focusedListItemId);
            }
            return next;
          });
          return;
        case "focus_prev":
          setFocusedListItemId((current) => moveFocusedMessage(listMetrics.collapsibleItemIds, current, -1));
          return;
        case "focus_next":
          setFocusedListItemId((current) => moveFocusedMessage(listMetrics.collapsibleItemIds, current, 1));
          return;
        case "scroll_up":
          setListScrollOffset((current) =>
            clamp(current - Math.max(2, Math.floor(listViewport.pageSize * 0.75)), 0, listViewport.maxScrollOffset)
          );
          return;
        case "scroll_down":
          setListScrollOffset((current) =>
            clamp(current + Math.max(2, Math.floor(listViewport.pageSize * 0.75)), 0, listViewport.maxScrollOffset)
          );
          return;
        default:
          break;
      }
    },
    {
      isActive: activeView !== "chat" && !viewModel?.pendingConfirmation && !busy && !layout.tooSmall
    }
  );

  useInput(
    (input, key) => {
      switch (resolveChatHotkey(input, key)) {
        case "toggle_expand":
          if (!focusedMessageId) {
            return;
          }

          setExpandedMessageIds((current) => {
            const next = new Set(current);
            if (next.has(focusedMessageId)) {
              next.delete(focusedMessageId);
            } else {
              next.add(focusedMessageId);
            }
            return next;
          });
          return;
        case "focus_prev":
          setFocusedMessageId((current) => moveFocusedMessage(chatMetrics.collapsibleMessageIds, current, -1));
          return;
        case "focus_next":
          setFocusedMessageId((current) => moveFocusedMessage(chatMetrics.collapsibleMessageIds, current, 1));
          return;
        case "scroll_up":
          setChatScrollOffset((current) =>
            clamp(current + Math.max(2, Math.floor(chatViewport.pageSize * 0.75)), 0, chatViewport.maxScrollOffset)
          );
          return;
        case "scroll_down":
          setChatScrollOffset((current) =>
            clamp(current - Math.max(2, Math.floor(chatViewport.pageSize * 0.75)), 0, chatViewport.maxScrollOffset)
          );
          return;
        default:
          break;
      }
    },
    {
      isActive: activeView === "chat" && !viewModel?.pendingConfirmation && !busy && !layout.tooSmall
    }
  );

  useInput(
    (input, key) => {
      const targetView = resolveViewHotkey(input, key);
      if (!targetView) {
        return;
      }

      void switchView(targetView);
    },
    {
      isActive: !viewModel?.pendingConfirmation && !busy && !layout.tooSmall
    }
  );

  useEffect(() => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin?.isTTY || !stdout?.isTTY) {
      return undefined;
    }

    stdout.write(ENABLE_MOUSE_REPORTING);

    const handleMouseData = (chunk) => {
      const events = parseMouseSequence(chunk);
      if (!events.length) {
        return;
      }

      mouseInputGuardUntilRef.current = Date.now() + MOUSE_INPUT_GUARD_MS;

      for (const event of events) {
        const action = resolveMouseAction(event, {
          layout,
          activeView,
          tabs,
          chatViewport,
          listViewport,
          pendingConfirmation: Boolean(viewModel?.pendingConfirmation),
          confirmationWidth: layout.confirmationWidth
        });

        if (!action) {
          continue;
        }

        if (action.type === "switch_view") {
          void switchView(action.view);
          continue;
        }

        if (action.type === "open_link") {
          openExternalUrl(action.url);
          continue;
        }

        if (action.type === "confirm" || action.type === "cancel") {
          void submitConfirmation(action.type);
          continue;
        }

        if (action.type === "chat_scroll_up") {
          setChatScrollOffset((current) =>
            clamp(current + Math.max(2, Math.floor(chatViewport.pageSize * 0.75)), 0, chatViewport.maxScrollOffset)
          );
          continue;
        }

        if (action.type === "chat_scroll_down") {
          setChatScrollOffset((current) =>
            clamp(current - Math.max(2, Math.floor(chatViewport.pageSize * 0.75)), 0, chatViewport.maxScrollOffset)
          );
          continue;
        }

        if (action.type === "list_scroll_up") {
          setListScrollOffset((current) =>
            clamp(current - Math.max(2, Math.floor(listViewport.pageSize * 0.75)), 0, listViewport.maxScrollOffset)
          );
          continue;
        }

        if (action.type === "list_scroll_down") {
          setListScrollOffset((current) =>
            clamp(current + Math.max(2, Math.floor(listViewport.pageSize * 0.75)), 0, listViewport.maxScrollOffset)
          );
          continue;
        }

        if (action.type === "focus_message") {
          setFocusedMessageId(action.id);
          continue;
        }

        if (action.type === "toggle_message") {
          setFocusedMessageId(action.id);
          setExpandedMessageIds((current) => {
            const next = new Set(current);
            if (next.has(action.id)) {
              next.delete(action.id);
            } else {
              next.add(action.id);
            }
            return next;
          });
          continue;
        }

        if (action.type === "focus_item") {
          setFocusedListItemId(action.id);
          continue;
        }

        if (action.type === "toggle_item") {
          setFocusedListItemId(action.id);
          setExpandedListItemIds((current) => {
            const next = new Set(current);
            if (next.has(action.id)) {
              next.delete(action.id);
            } else {
              next.add(action.id);
            }
            return next;
          });
        }
      }
    };

    stdin.on("data", handleMouseData);

    return () => {
      stdin.off("data", handleMouseData);
      stdout.write(DISABLE_MOUSE_REPORTING);
    };
  }, [
    activeView,
    chatViewport,
    layout,
    listViewport,
    tabs,
    viewModel?.pendingConfirmation
  ]);

  useInput(
    (input, key) => {
      if (!viewModel || busy || viewModel.pendingConfirmation || layout.tooSmall) {
        return;
      }

      if (Date.now() < mouseInputGuardUntilRef.current) {
        return;
      }

      if (!shouldHandleInputBarKey(input, key)) {
        return;
      }

      if (key.return) {
        if (inputValue.trim()) {
          void submitPrompt(inputValue);
        }
        return;
      }

      if (key.backspace || (key.delete && !input)) {
        if (inputCursor <= 0) {
          return;
        }

        setInputValue((current) => current.slice(0, inputCursor - 1) + current.slice(inputCursor));
        setInputCursor((current) => Math.max(0, current - 1));
        setHistoryIndex(null);
        return;
      }

      if (key.leftArrow || (key.ctrl && input === "b")) {
        setInputCursor((current) => Math.max(0, current - 1));
        return;
      }

      if (key.rightArrow || (key.ctrl && input === "f")) {
        setInputCursor((current) => Math.min(inputValue.length, current + 1));
        return;
      }

      if (key.upArrow) {
        if (!inputHistory.length) {
          return;
        }

        const nextIndex = historyIndex === null ? inputHistory.length - 1 : Math.max(0, historyIndex - 1);
        const nextValue = inputHistory[nextIndex] || "";
        setHistoryIndex(nextIndex);
        setInputValue(nextValue);
        setInputCursor(nextValue.length);
        return;
      }

      if (key.downArrow) {
        if (historyIndex === null) {
          return;
        }

        const nextIndex = historyIndex + 1;
        if (nextIndex >= inputHistory.length) {
          setHistoryIndex(null);
          setInputValue("");
          setInputCursor(0);
          return;
        }

        const nextValue = inputHistory[nextIndex] || "";
        setHistoryIndex(nextIndex);
        setInputValue(nextValue);
        setInputCursor(nextValue.length);
        return;
      }

      if (key.ctrl && input === "a") {
        setInputCursor(0);
        return;
      }

      if (key.ctrl && input === "e") {
        setInputCursor(inputValue.length);
        return;
      }

      if (key.escape || key.tab || key.alt || key.meta || key.ctrl) {
        return;
      }

      if (!isPrintableInput(input)) {
        return;
      }

      setInputValue((current) => current.slice(0, inputCursor) + input + current.slice(inputCursor));
      setInputCursor((current) => current + input.length);
      setHistoryIndex(null);
    },
    {
      isActive: true
    }
  );

  async function submitPrompt(submitted, options = {}) {
    const { recordAsUser = true } = options;
    const memoryLimit = viewModel?.meta?.conversationMemoryLimit;
    const normalizedSubmitted = String(submitted || "");

    setInputValue("");
    setInputCursor(0);
    setHistoryIndex(null);
    if (recordAsUser && normalizedSubmitted.trim()) {
      setInputHistory((current) => {
        const next = current.filter((entry) => entry !== normalizedSubmitted.trim());
        next.push(normalizedSubmitted.trim());
        return next.slice(-200);
      });
    }

    if (recordAsUser) {
      setMessages((current) =>
        trimChatMessages([...current, ...attachMessageIds([{ role: "user", text: normalizedSubmitted }])], memoryLimit)
      );
    } else {
      setMessages((current) =>
        trimChatMessages([...current, ...attachMessageIds([{ role: "system", text: normalizedSubmitted }])], memoryLimit)
      );
    }
    setChatScrollOffset(0);

    setBusy(true);

    try {
      const result = await controller.handleInput(normalizedSubmitted, { activeView });
      const nextView = result.nextView || activeView;
      const nextViewModel = await controller.getViewModel({ activeView: nextView });

      if (!mountedRef.current) {
        return;
      }

      setActiveView(nextView);
      setViewModel(nextViewModel);
      setMessages((current) =>
        trimChatMessages(
          [...current, ...attachMessageIds([{ role: "assistant", text: result.reply }])],
          nextViewModel.meta?.conversationMemoryLimit
        )
      );
      setChatScrollOffset(0);

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

    try {
      const result = await controller.resolveConfirmation(action);
      const nextView = result.nextView || activeView;
      const nextViewModel = await controller.getViewModel({ activeView: nextView });

      if (!mountedRef.current) {
        return;
      }

      setActiveView(nextView);
      setViewModel(nextViewModel);
      setMessages((current) =>
        trimChatMessages(
          [
            ...current,
            ...attachMessageIds([
              { role: "system", text: action === "confirm" ? "[confirm]" : "[cancel]" },
              { role: "assistant", text: result.reply }
            ])
          ],
          nextViewModel.meta?.conversationMemoryLimit
        )
      );
      setChatScrollOffset(0);

      if (result.shouldExit) {
        exit();
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }

  async function switchView(targetView) {
    if (!VIEW_HOTKEYS.includes(targetView) || targetView === activeView) {
      return;
    }

    setBusy(true);

    try {
      const nextViewModel = await controller.getViewModel({ activeView: targetView });
      if (!mountedRef.current) {
        return;
      }

      setActiveView(targetView);
      setViewModel(nextViewModel);
      setListScrollOffset(0);
      setFocusedListItemId(null);
      setExpandedListItemIds(new Set());
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
          chatViewport,
          listViewport
        })
      )
    ),
    createElement(FooterStatus, { busy }),
    createElement(InputBar, {
      value: inputValue,
      cursor: inputCursor,
      busy,
      disabled: !viewModel || busy || layout.tooSmall,
      pendingConfirmation: Boolean(viewModel.pendingConfirmation)
    }),
    viewModel.pendingConfirmation
      ? createElement(ConfirmationOverlay, {
          message: viewModel.pendingConfirmation.message,
          width: layout.confirmationWidth,
          selection: confirmationSelection
        })
      : null
  );
}

function trimChatMessages(messages, memoryLimit = 40) {
  const limit = Number.isFinite(Number(memoryLimit)) && Number(memoryLimit) > 0
    ? Number(memoryLimit)
    : 40;
  return messages.slice(-limit);
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
  const speechPreview = summarizePetSpeech(viewModel.lastReply);

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG, minHeight },
    createElement(SectionLabel, { title: "pet", color: "magentaBright" }),
    ...petLines.map((line, index) =>
      createElement(Text, { key: `pet-${index}`, color: "white" }, line)
    ),
    createElement(Text, { color: "gray" }, `mood    ${viewModel.petMood}`),
    createElement(Text, { color: "gray", dimColor: true }, `say     ${speechPreview}`)
  );
}

function MainPanel({ activeView, panels, chatViewport, listViewport }) {
  if (activeView === "chat") {
    return createElement(ChatPanel, {
      viewport: chatViewport
    });
  }

  return createElement(ListPanel, {
    title: activeView,
    viewport: listViewport || buildListViewport(panels[activeView]?.lines || ["(empty)"], { title: activeView })
  });
}

function ChatPanel({ viewport }) {
  return createElement(
    Box,
    { flexDirection: "column", flexGrow: 1, height: "100%", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG_ALT },
    createElement(SectionLabel, { title: "conversation", color: "cyanBright" }),
    createElement(
      Text,
      { color: "gray", dimColor: true },
      buildChatStatusLine(viewport)
    ),
    createElement(
      Box,
      { flexDirection: "column", marginTop: 1 },
      ...viewport.visibleMessages.map((message, index) =>
        createElement(LogMessage, { key: `${message.role}-${index}`, message })
      )
    )
  );
}

export function buildChatViewport(
  messages,
  { maxLines = 12, widthChars = 72, scrollOffset = 0, expandedMessageIds = new Set(), focusedMessageId = null } = {}
) {
  const safeMaxLines = Number.isFinite(Number(maxLines)) ? Math.max(1, Number(maxLines)) : 12;
  const metrics = summarizeChatMessages(messages, { widthChars, expandedMessageIds, focusedMessageId });
  const maxScrollOffset = Math.max(0, metrics.totalLines - safeMaxLines);
  const safeOffset = clamp(Number(scrollOffset) || 0, 0, maxScrollOffset);
  const windowEnd = metrics.totalLines - safeOffset;
  const windowStart = Math.max(0, windowEnd - safeMaxLines);
  const visibleMessages = [];

  for (const message of metrics.messages) {
    const overlapStart = Math.max(windowStart, message.rowStart);
    const overlapEnd = Math.min(windowEnd, message.rowEnd);

    if (overlapStart >= overlapEnd) {
      continue;
    }

    visibleMessages.push(sliceChatMessageForViewport(message, overlapStart - message.rowStart, overlapEnd - message.rowStart));
  }

  return {
    visibleMessages,
    scrollOffset: safeOffset,
    maxScrollOffset,
    totalLines: metrics.totalLines,
    pageSize: safeMaxLines,
    collapsibleMessageIds: metrics.collapsibleMessageIds,
    focusedMessageId
  };
}

export function selectVisibleChatMessages(messages, options = {}) {
  return buildChatViewport(messages, options).visibleMessages;
}

export function summarizeChatMessages(
  messages,
  { widthChars = 72, expandedMessageIds = new Set(), focusedMessageId = null } = {}
) {
  const contentWidth = Math.max(12, Math.floor(widthChars) - CHAT_LABEL_WIDTH - 2);
  const expandedSet = expandedMessageIds instanceof Set ? expandedMessageIds : new Set(expandedMessageIds);
  const projectedMessages = [];
  const collapsibleMessageIds = [];
  let totalLines = 0;

  for (const message of messages) {
    const projected = projectChatMessage(message, contentWidth, expandedSet, focusedMessageId);
    if (projected.isCollapsible) {
      collapsibleMessageIds.push(projected.id);
    }

    projected.rowStart = totalLines;
    totalLines += projected.displayLines.length;
    projected.rowEnd = totalLines;
    projectedMessages.push(projected);
  }

  return {
    messages: projectedMessages,
    collapsibleMessageIds,
    totalLines
  };
}

function estimateChatMessageRows(message, contentWidth) {
  const wrappedLines = wrapTextLines(message?.text || "", contentWidth);
  return Math.max(1, wrappedLines.length);
}

function wrapTextLines(text, width) {
  const safeWidth = Math.max(1, width);
  const sourceLines = String(text || "").split("\n");
  const wrapped = [];

  for (const line of sourceLines) {
    if (!line) {
      wrapped.push("");
      continue;
    }

    let currentLine = "";
    let currentWidth = 0;

    for (const char of Array.from(line)) {
      const charWidth = getDisplayWidth(char);
      if (currentLine && currentWidth + charWidth > safeWidth) {
        wrapped.push(currentLine);
        currentLine = "";
        currentWidth = 0;
      }

      currentLine += char;
      currentWidth += charWidth;

      if (currentWidth >= safeWidth) {
        wrapped.push(currentLine);
        currentLine = "";
        currentWidth = 0;
      }
    }

    if (currentLine || !wrapped.length) {
      wrapped.push(currentLine);
    }
  }

  return wrapped.length ? wrapped : [""];
}

function getDisplayWidth(text) {
  let width = 0;

  for (const char of Array.from(String(text || ""))) {
    width += getCharacterDisplayWidth(char);
  }

  return width;
}

function getCharacterDisplayWidth(char) {
  const codePoint = char.codePointAt(0);
  if (!codePoint) {
    return 0;
  }

  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return 0;
  }

  if (/\p{Mark}/u.test(char)) {
    return 0;
  }

  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) {
    return 2;
  }

  return 1;
}

function projectChatMessage(message, contentWidth, expandedMessageIds, focusedMessageId) {
  const wrappedLines = wrapTextLines(message?.text || "", contentWidth);
  const hiddenLineCount = Math.max(0, wrappedLines.length - COLLAPSED_ASSISTANT_LINES);
  const isCollapsible = message?.role === "assistant" && hiddenLineCount > 0;
  const isExpanded = isCollapsible && expandedMessageIds.has(message.id);
  const visibleBodyLines = isCollapsible && !isExpanded
    ? wrappedLines.slice(0, COLLAPSED_ASSISTANT_LINES)
    : wrappedLines;
  const displayLines = isCollapsible && !isExpanded
    ? [...visibleBodyLines, `… ${hiddenLineCount}줄 더 있음`]
    : visibleBodyLines;

  return {
    ...message,
    displayLines,
    isCollapsible,
    isExpanded,
    isFocused: message.id === focusedMessageId,
    hiddenLineCount
  };
}

function sliceChatMessageForViewport(message, startLine, endLine) {
  const slicedLines = message.displayLines.slice(startLine, endLine);
  if (startLine > 0 && slicedLines.length > 0) {
    slicedLines[0] = prefixEllipsis(slicedLines[0]);
  }

  if (endLine < message.displayLines.length && slicedLines.length > 0) {
    slicedLines[slicedLines.length - 1] = suffixEllipsis(slicedLines[slicedLines.length - 1]);
  }

  return {
    ...message,
    text: slicedLines.join("\n"),
    visibleLineCount: slicedLines.length,
    truncatedTop: startLine > 0,
    truncatedBottom: endLine < message.displayLines.length
  };
}

function prefixEllipsis(line) {
  if (!line) {
    return "…";
  }

  return line.startsWith("…") ? line : `… ${line}`;
}

function suffixEllipsis(line) {
  if (!line) {
    return "…";
  }

  return line.endsWith("…") ? line : `${line} …`;
}

export function buildListViewport(
  lines,
  { title = "panel", maxLines = 12, widthChars = 72, scrollOffset = 0, expandedItemIds = new Set(), focusedItemId = null } = {}
) {
  const safeMaxLines = Number.isFinite(Number(maxLines)) ? Math.max(1, Number(maxLines)) : 12;
  const metrics = summarizeListItems(lines, { title, widthChars, expandedItemIds, focusedItemId });
  const maxScrollOffset = Math.max(0, metrics.totalLines - safeMaxLines);
  const safeOffset = clamp(Number(scrollOffset) || 0, 0, maxScrollOffset);
  const windowStart = safeOffset;
  const windowEnd = Math.min(metrics.totalLines, windowStart + safeMaxLines);
  const visibleItems = [];

  for (const item of metrics.items) {
    const overlapStart = Math.max(windowStart, item.rowStart);
    const overlapEnd = Math.min(windowEnd, item.rowEnd);

    if (overlapStart >= overlapEnd) {
      continue;
    }

    visibleItems.push(sliceListItemForViewport(item, overlapStart - item.rowStart, overlapEnd - item.rowStart));
  }

  return {
    visibleItems,
    scrollOffset: safeOffset,
    maxScrollOffset,
    totalLines: metrics.totalLines,
    pageSize: safeMaxLines,
    collapsibleItemIds: metrics.collapsibleItemIds,
    focusedItemId
  };
}

export function summarizeListItems(
  lines,
  { title = "panel", widthChars = 72, expandedItemIds = new Set(), focusedItemId = null } = {}
) {
  const contentWidth = Math.max(12, Math.floor(widthChars) - 4);
  const expandedSet = expandedItemIds instanceof Set ? expandedItemIds : new Set(expandedItemIds);
  const projectedItems = [];
  const collapsibleItemIds = [];
  let totalLines = 0;

  (Array.isArray(lines) ? lines : ["(empty)"]).forEach((line, index) => {
    const projected = projectListItem(line, index, title, contentWidth, expandedSet, focusedItemId);
    if (projected.isCollapsible) {
      collapsibleItemIds.push(projected.id);
    }

    projected.rowStart = totalLines;
    totalLines += projected.displayLines.length;
    projected.rowEnd = totalLines;
    projectedItems.push(projected);
  });

  return {
    items: projectedItems,
    collapsibleItemIds,
    totalLines
  };
}

function projectListItem(line, index, title, contentWidth, expandedItemIds, focusedItemId) {
  const wrappedLines = wrapTextLines(line || "", contentWidth);
  const hiddenLineCount = Math.max(0, wrappedLines.length - COLLAPSED_ASSISTANT_LINES);
  const id = `${title}-${index}`;
  const isHeader = isSectionHeader(line);
  const isCollapsible = title !== "github" && !isHeader && hiddenLineCount > 0;
  const isExpanded = isCollapsible && expandedItemIds.has(id);
  const visibleBodyLines = isCollapsible && !isExpanded
    ? wrappedLines.slice(0, COLLAPSED_ASSISTANT_LINES)
    : wrappedLines;
  const displayLines = isCollapsible && !isExpanded
    ? [...visibleBodyLines, `… ${hiddenLineCount}줄 더 있음`]
    : visibleBodyLines;

  return {
    id,
    line,
    displayLines,
    isHeader,
    isCollapsible,
    isExpanded,
    isFocused: id === focusedItemId
  };
}

function sliceListItemForViewport(item, startLine, endLine) {
  const slicedLines = item.displayLines.slice(startLine, endLine);
  if (startLine > 0 && slicedLines.length > 0) {
    slicedLines[0] = prefixEllipsis(slicedLines[0]);
  }

  if (endLine < item.displayLines.length && slicedLines.length > 0) {
    slicedLines[slicedLines.length - 1] = suffixEllipsis(slicedLines[slicedLines.length - 1]);
  }

  return {
    ...item,
    text: slicedLines.join("\n")
  };
}

function ListPanel({ title, viewport }) {

  return createElement(
    Box,
    { flexDirection: "column", flexGrow: 1, height: "100%", paddingX: 1, paddingY: 1, backgroundColor: SURFACE_BG_ALT },
    createElement(SectionLabel, { title, color: "cyanBright" }),
    createElement(
      Text,
      { color: "gray", dimColor: true },
      buildListStatusLine(viewport)
    ),
    createElement(
      Box,
      { flexDirection: "column", marginTop: 1 },
      ...viewport.visibleItems.map((item, index) =>
        createElement(ListItem, { key: `${item.id}-${index}`, item })
      )
    )
  );
}

function ListItem({ item }) {
  return createElement(
    Box,
    { flexDirection: "column" },
    ...item.text.split("\n").map((line, index) => {
      const isHiddenIndicator = /^… \d+줄 더 있음/.test(line);
      const displayLine = item.isFocused && index === 0 ? `› ${line}` : line;
      const color = item.isFocused && !isHiddenIndicator
        ? "cyanBright"
        : item.isHeader || isHiddenIndicator
          ? "gray"
          : "white";

      return createElement(
        RichTextLine,
        {
          key: `${item.id}-${index}`,
          line: displayLine,
          color,
          dimColor: isHiddenIndicator
        }
      );
    })
  );
}

export function isSectionHeader(line) {
  return typeof line === "string" && GITHUB_SECTION_HEADERS.has(line.trim().toLowerCase());
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

function InputBar({ value, cursor, busy, disabled, pendingConfirmation }) {
  const { beforeCursor, cursorChar, afterCursor } = splitInputCursor(value, cursor);
  let placeholder = "";

  if (pendingConfirmation) {
    placeholder = "확인창이 열려 있어. Enter/Esc 또는 마우스로 선택해줘.";
  } else if (busy) {
    placeholder = "응답을 기다리는 중...";
  } else if (disabled) {
    placeholder = "입력을 잠시 멈췄어.";
  }

  return createElement(
    Box,
    {
      height: 1,
      paddingX: 1,
      backgroundColor: FOOTER_BG
    },
    createElement(Text, { color: "gray" }, "› "),
    disabled || pendingConfirmation
      ? createElement(Text, { color: "gray", dimColor: true }, placeholder)
      : createElement(
          Box,
          null,
          createElement(Text, { color: "white" }, beforeCursor),
          createElement(
            Text,
            {
              color: "black",
              backgroundColor: "white"
            },
            cursorChar
          ),
          createElement(Text, { color: "white" }, afterCursor)
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
  const roleText = message.isFocused ? `${roleLabel(message.role)}*` : roleLabel(message.role);

  return createElement(
    Box,
    { flexDirection: "row" },
    createElement(
      Box,
      { width: CHAT_LABEL_WIDTH, flexShrink: 0 },
      createElement(Text, { color: roleColor(message.role), bold: message.role !== "system" }, roleText)
    ),
    createElement(
      Box,
      { flexDirection: "column" },
      ...message.text.split("\n").map((line, index) =>
        createElement(
          RichTextLine,
          {
            key: `${message.role}-${index}`,
            line,
            color: message.role === "system" || /^… \d+줄 더 있음/.test(line) ? "gray" : "white",
            dimColor: /^… \d+줄 더 있음/.test(line)
          },
        )
      )
    )
  );
}

function RichTextLine({ line, color = "white", dimColor = false }) {
  const segments = splitLineIntoHyperlinkSegments(line);

  return createElement(
    Box,
    { flexDirection: "row" },
    ...segments.map((segment, index) =>
      createElement(
        Text,
        {
          key: `${segment.type}-${index}`,
          color: segment.type === "link" ? "blueBright" : color,
          dimColor,
          underline: segment.type === "link"
        },
        segment.text
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
    case "playful":
      return "magentaBright";
    case "curious":
      return "blueBright";
    case "sleepy":
      return "white";
    case "proud":
      return "yellowBright";
    case "shy":
      return "cyanBright";
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

export function parseMouseSequence(input) {
  const source = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  const events = [];
  const sgrPattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let match;

  while ((match = sgrPattern.exec(source))) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const suffix = match[4];

    if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    if (code >= 64) {
      events.push({
        kind: code === 64 ? "wheel_up" : "wheel_down",
        x,
        y
      });
      continue;
    }

    events.push({
      kind: suffix === "M" ? "press" : "release",
      button: resolveMouseButton(code),
      x,
      y
    });
  }

  return events;
}

export function resolveMouseAction(event, context) {
  const {
    layout,
    activeView,
    tabs = [],
    chatViewport,
    listViewport,
    pendingConfirmation = false,
    confirmationWidth = 40
  } = context || {};

  if (!event || !layout || layout.tooSmall) {
    return null;
  }

  if (pendingConfirmation && event.kind === "press" && event.button === "left") {
    return resolveConfirmationMouseAction(event, layout, confirmationWidth);
  }

  const tabAction = resolveTabMouseAction(event, tabs);
  if (tabAction) {
    return tabAction;
  }

  if (event.kind === "wheel_up") {
    return activeView === "chat" ? { type: "chat_scroll_up" } : { type: "list_scroll_up" };
  }

  if (event.kind === "wheel_down") {
    return activeView === "chat" ? { type: "chat_scroll_down" } : { type: "list_scroll_down" };
  }

  if (event.kind !== "press" || event.button !== "left") {
    return null;
  }

  if (activeView === "chat") {
    return resolveChatMouseAction(event, layout, chatViewport);
  }

  return resolveListMouseAction(event, layout, listViewport);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function summarizePetSpeech(text, maxChars = 26) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }

  if (!Number.isFinite(Number(maxChars)) || Number(maxChars) < 4) {
    return normalized;
  }

  const safeMaxChars = Math.floor(Number(maxChars));
  return normalized.length > safeMaxChars
    ? `${normalized.slice(0, safeMaxChars - 1)}…`
    : normalized;
}

export function splitLineIntoHyperlinkSegments(line) {
  const source = String(line || "");
  const segments = [];
  const urlPattern = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
  let cursor = 0;
  let match;

  while ((match = urlPattern.exec(source))) {
    const rawUrl = match[1];
    const start = match.index;
    const { displayUrl, normalizedUrl, trailingText } = normalizeDetectedUrl(rawUrl);

    if (start > cursor) {
      pushTextSegment(segments, source.slice(cursor, start));
    }

    if (displayUrl) {
      segments.push({ type: "link", text: displayUrl, url: normalizedUrl });
    }

    if (trailingText) {
      pushTextSegment(segments, trailingText);
    }

    cursor = start + rawUrl.length;
  }

  if (cursor < source.length) {
    pushTextSegment(segments, source.slice(cursor));
  }

  return segments.length ? segments : [{ type: "text", text: source }];
}

export function formatTerminalHyperlink(label, url) {
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

export function buildOpenUrlCommand(url, platform = process.platform) {
  if (!/^https?:\/\//i.test(String(url || ""))) {
    return null;
  }

  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

export function openExternalUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const command = buildOpenUrlCommand(url, platform);
  if (!command) {
    return false;
  }

  try {
    const child = spawnImpl(command.command, command.args, {
      stdio: "ignore",
      detached: true
    });

    if (typeof child?.unref === "function") {
      child.unref();
    }

    return true;
  } catch {
    return false;
  }
}

function normalizeDetectedUrl(rawUrl) {
  const trimmed = String(rawUrl || "").replace(/[),.;!?]+$/g, "");
  const trailingText = String(rawUrl || "").slice(trimmed.length);
  const normalizedUrl = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;

  return {
    displayUrl: trimmed,
    normalizedUrl,
    trailingText
  };
}

function pushTextSegment(segments, text) {
  if (!text) {
    return;
  }

  const last = segments.at(-1);
  if (last?.type === "text") {
    last.text += text;
    return;
  }

  segments.push({ type: "text", text });
}

function resolveMouseButton(code) {
  switch (code & 0b11) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "other";
  }
}

function resolveTabMouseAction(event, tabs) {
  if (event.kind !== "press" || event.button !== "left") {
    return null;
  }

  if (event.y < 4 || event.y > 5) {
    return null;
  }

  let cursorX = 3;
  for (const tab of tabs) {
    const label = tab.active ? `[${tab.label}]` : tab.label;
    const startX = cursorX;
    const endX = startX + label.length - 1;
    if (event.x >= startX && event.x <= endX) {
      return tab.active ? null : { type: "switch_view", view: tab.id };
    }
    cursorX = endX + 3;
  }

  return null;
}

function resolveConfirmationMouseAction(event, layout, width) {
  const overlayWidth = Math.max(24, Math.min(width, layout.columns - 4));
  const boxStartX = Math.max(2, Math.floor((layout.columns - overlayWidth) / 2) + 1);
  const boxEndX = boxStartX + overlayWidth - 1;
  const boxHeight = 6;
  const boxStartY = Math.max(2, Math.floor((layout.viewportRows - boxHeight) / 2) + 1);
  const boxEndY = boxStartY + boxHeight - 1;

  if (event.x < boxStartX || event.x > boxEndX || event.y < boxStartY || event.y > boxEndY) {
    return null;
  }

  const splitX = Math.floor((boxStartX + boxEndX) / 2);
  return event.x <= splitX ? { type: "confirm" } : { type: "cancel" };
}

function resolveChatMouseAction(event, layout, viewport) {
  if (!viewport?.visibleMessages?.length) {
    return null;
  }

  const row = resolvePanelContentRow(event.y, layout);
  const contentColumn = resolvePanelContentColumn(event.x, layout);
  if (row === null) {
    return null;
  }

  let currentRow = 0;
  for (const message of viewport.visibleMessages) {
    const renderedLines = String(message.text || "").split("\n");
    const lineCount = renderedLines.length;
    const rowStart = currentRow;
    const rowEnd = rowStart + lineCount - 1;
    if (row >= rowStart && row <= rowEnd) {
      const lineIndex = row - rowStart;
      const line = renderedLines[lineIndex] || "";
      const bodyColumn = contentColumn === null ? null : contentColumn - CHAT_LABEL_WIDTH;
      const linkUrl = bodyColumn === null ? null : findLinkUrlAtColumn(line, bodyColumn);
      if (linkUrl) {
        return { type: "open_link", url: linkUrl };
      }

      if (!message.isCollapsible) {
        return null;
      }

      return viewport.focusedMessageId === message.id
        ? { type: "toggle_message", id: message.id }
        : { type: "focus_message", id: message.id };
    }

    currentRow = rowEnd + 1;
  }

  return null;
}

function resolveListMouseAction(event, layout, viewport) {
  if (!viewport?.visibleItems?.length) {
    return null;
  }

  const row = resolvePanelContentRow(event.y, layout);
  const contentColumn = resolvePanelContentColumn(event.x, layout);
  if (row === null) {
    return null;
  }

  let currentRow = 0;
  for (const item of viewport.visibleItems) {
    const renderedLines = String(item.text || "").split("\n");
    const lineCount = renderedLines.length;
    const rowStart = currentRow;
    const rowEnd = rowStart + lineCount - 1;
    if (row >= rowStart && row <= rowEnd) {
      const lineIndex = row - rowStart;
      const rawLine = renderedLines[lineIndex] || "";
      const renderedLine = item.isFocused && lineIndex === 0 ? `› ${rawLine}` : rawLine;
      const linkUrl = contentColumn === null ? null : findLinkUrlAtColumn(renderedLine, contentColumn);
      if (linkUrl) {
        return { type: "open_link", url: linkUrl };
      }

      if (!item.isCollapsible) {
        return null;
      }

      return viewport.focusedItemId === item.id
        ? { type: "toggle_item", id: item.id }
        : { type: "focus_item", id: item.id };
    }

    currentRow = rowEnd + 1;
  }

  return null;
}

function resolvePanelContentRow(screenY, layout) {
  const mainPanelStartY = layout.stacked
    ? 7 + layout.petMinHeight + 1
    : 7;
  const contentStartY = mainPanelStartY + 5;
  const contentRow = screenY - contentStartY;
  return contentRow >= 0 ? contentRow : null;
}

function resolvePanelContentColumn(screenX, layout) {
  const mainPanelStartX = layout.stacked ? 2 : 2 + layout.petWidth;
  const contentStartX = mainPanelStartX + 1;
  const contentColumn = screenX - contentStartX;
  return contentColumn >= 0 ? contentColumn : null;
}

function countRenderedLines(text) {
  return String(text || "").split("\n").length;
}

function findLinkUrlAtColumn(line, column) {
  if (!Number.isFinite(column) || column < 0) {
    return null;
  }

  let cursor = 0;
  for (const segment of splitLineIntoHyperlinkSegments(line)) {
    const segmentWidth = getDisplayWidth(segment.text);
    if (column >= cursor && column < cursor + segmentWidth) {
      return segment.type === "link" ? segment.url : null;
    }

    cursor += segmentWidth;
  }

  return null;
}

function buildChatStatusLine(viewport) {
  const scrollText = viewport.scrollOffset > 0
    ? `scroll ${viewport.scrollOffset}/${viewport.maxScrollOffset}`
    : "latest";
  const focusableCount = viewport.collapsibleMessageIds.length;
  const focusText = focusableCount > 0
    ? `긴 답변 ${focusableCount}개 · Alt/Option+←/→ 선택 · Alt/Option+O 또는 Ctrl+O 펼치기`
    : "긴 답변 없음";

  return `${scrollText} · Alt+↑/↓ scroll · ${focusText} · F1-F5 탭`;
}

function buildListStatusLine(viewport) {
  const scrollText = viewport.scrollOffset > 0
    ? `scroll ${viewport.scrollOffset}/${viewport.maxScrollOffset}`
    : "top";
  const focusableCount = viewport.collapsibleItemIds.length;
  const focusText = focusableCount > 0
    ? `긴 항목 ${focusableCount}개 · Alt/Option+←/→ 선택 · Alt/Option+O 또는 Ctrl+O 펼치기`
    : "긴 항목 없음";

  return `${scrollText} · Alt+↑/↓ scroll · ${focusText} · F1-F5 탭`;
}

function moveFocusedMessage(messageIds, currentId, direction) {
  if (!messageIds.length) {
    return null;
  }

  const currentIndex = messageIds.indexOf(currentId);
  if (currentIndex === -1) {
    return direction < 0 ? messageIds.at(-1) : messageIds[0];
  }

  return messageIds[clamp(currentIndex + direction, 0, messageIds.length - 1)];
}

function matchesPageUp(input, key) {
  return Boolean(key.pageUp || input === "\u001b[5~");
}

function matchesPageDown(input, key) {
  return Boolean(key.pageDown || input === "\u001b[6~");
}

function areSetsEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

export function resolveChatHotkey(input, key = {}) {
  if (matchesPageUp(input, key) || isModifiedArrow(key, "upArrow") || (key.ctrl && input === "b")) {
    return "scroll_up";
  }

  if (matchesPageDown(input, key) || isModifiedArrow(key, "downArrow") || (key.ctrl && input === "f")) {
    return "scroll_down";
  }

  if (isModifiedArrow(key, "leftArrow") || (key.ctrl && input === "p")) {
    return "focus_prev";
  }

  if (isModifiedArrow(key, "rightArrow") || (key.ctrl && input === "n")) {
    return "focus_next";
  }

  const normalized = normalizeHotkeyInput(input).toLowerCase();

  if (((key.alt || key.meta) && normalized === "o") || (key.ctrl && normalized === "o")) {
    return "toggle_expand";
  }

  return null;
}

export function resolveViewHotkey(input, key = {}) {
  const normalized = normalizeHotkeyInput(input);

  if (key.alt && /^[1-5]$/.test(normalized)) {
    return VIEW_HOTKEYS[Number(normalized) - 1] || null;
  }

  const functionView = FUNCTION_KEY_VIEW_MAP[input];
  if (functionView) {
    return functionView;
  }

  return null;
}

const FUNCTION_KEY_VIEW_MAP = {
  "\u001bOP": "chat",
  "\u001bOQ": "memo",
  "\u001bOR": "todo",
  "\u001bOS": "schedule",
  "\u001b[15~": "github",
  "\u001b[11~": "chat",
  "\u001b[12~": "memo",
  "\u001b[13~": "todo",
  "\u001b[14~": "schedule"
};

function normalizeHotkeyInput(input) {
  if (typeof input !== "string") {
    return "";
  }

  return input.replace(/^\u001b/, "");
}

function isModifiedArrow(key, arrowName) {
  return Boolean((key.alt || key.meta || key.ctrl) && key[arrowName]);
}

export function shouldHandleInputBarKey(input, key = {}) {
  const normalized = normalizeHotkeyInput(input).toLowerCase();

  if (key.alt || key.meta) {
    return false;
  }

  if (key.ctrl && normalized !== "a" && normalized !== "e") {
    return false;
  }

  return true;
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

function isPrintableInput(input) {
  return typeof input === "string" && input.length > 0 && !/[\u0000-\u001f\u007f]/.test(input);
}

function splitInputCursor(value, cursor) {
  const safeValue = String(value || "");
  const safeCursor = clamp(Number(cursor) || 0, 0, safeValue.length);
  const hasCharacterAtCursor = safeCursor < safeValue.length;

  return {
    beforeCursor: safeValue.slice(0, safeCursor),
    cursorChar: hasCharacterAtCursor ? safeValue[safeCursor] : " ",
    afterCursor: hasCharacterAtCursor ? safeValue.slice(safeCursor + 1) : ""
  };
}
