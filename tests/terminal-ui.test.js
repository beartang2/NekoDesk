import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenUrlCommand,
  buildChatViewport,
  buildListViewport,
  buildPaletteCommands,
  buildViewTabs,
  calculateResponsiveLayout,
  filterPaletteCommands,
  isSectionHeader,
  openExternalUrl,
  formatTerminalHyperlink,
  parseMouseSequence,
  resolveChatHotkey,
  resolveMouseAction,
  resolveViewHotkey,
  shouldHandleInputBarKey,
  splitLineIntoHyperlinkSegments,
  selectVisibleChatMessages,
  summarizePetSpeech
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
  assert.ok(narrow.mainPanelWidth < wide.mainPanelWidth);
});

test("calculateResponsiveLayout flags unsupported terminal sizes", () => {
  const tiny = calculateResponsiveLayout(60, 18);
  const safe = calculateResponsiveLayout(100, 30);

  assert.equal(tiny.tooSmall, true);
  assert.equal(safe.tooSmall, false);
  assert.ok(safe.bodyHeight > tiny.bodyHeight);
});

test("calculateResponsiveLayout reserves panel chrome rows from chat and list viewports", () => {
  const layout = calculateResponsiveLayout(120, 30);

  assert.equal(layout.bodyHeight - layout.chatMessageLimit, 6);
  assert.equal(layout.bodyHeight - layout.listMaxLines, 6);
  assert.equal(layout.bodyHeight - layout.githubMaxLines, 6);
});

test("isSectionHeader only marks known GitHub section labels", () => {
  assert.equal(isSectionHeader("account"), true);
  assert.equal(isSectionHeader("notes"), true);
  assert.equal(isSectionHeader("#1 README 정리"), false);
  assert.equal(isSectionHeader("[ ] 1. 회의 준비"), false);
  assert.equal(isSectionHeader("all day 회의"), false);
});

test("selectVisibleChatMessages keeps the newest messages within the line budget", () => {
  const visible = selectVisibleChatMessages(
    [
      { role: "user", text: "첫째" },
      { role: "assistant", text: "둘째" },
      { role: "user", text: "아주 길어서 여러 줄로 접히는 문장입니다".repeat(3) },
      { role: "assistant", text: "마지막 응답" }
    ],
    { maxLines: 4, widthChars: 24 }
  );

  assert.equal(visible.at(-1)?.text, "마지막 응답");
  assert.ok(!visible.some((message) => message.text === "첫째"));
});

test("selectVisibleChatMessages shows the latest visible slice for an oversized single message", () => {
  const visible = selectVisibleChatMessages(
    [{ id: "msg-1", role: "assistant", text: "1234567890abcdefghijklmnopqrstuvwxyz" }],
    { maxLines: 2, widthChars: 18 }
  );

  assert.equal(visible.length, 1);
  assert.equal(visible[0].text, "… cdefghijklmn\nopqrstuvwxyz");
});

test("summarizePetSpeech keeps the pet status on one line", () => {
  assert.equal(summarizePetSpeech("짧은 답변"), "짧은 답변");
  assert.equal(summarizePetSpeech("여러 줄로\n길게 이어지는 답변입니다", 12), "여러 줄로 길게 이어…");
  assert.equal(summarizePetSpeech("", 12), "-");
});

test("splitLineIntoHyperlinkSegments detects urls and keeps trailing punctuation out of the link", () => {
  const segments = splitLineIntoHyperlinkSegments("문서: https://example.com/docs, 여기 참고");
  assert.deepEqual(segments, [
    { type: "text", text: "문서: " },
    { type: "link", text: "https://example.com/docs", url: "https://example.com/docs" },
    { type: "text", text: ", 여기 참고" }
  ]);
});

test("formatTerminalHyperlink wraps link text in OSC 8 sequences", () => {
  const formatted = formatTerminalHyperlink("example", "https://example.com");
  assert.match(formatted, /\u001b]8;;https:\/\/example\.com\u0007example\u001b]8;;\u0007/);
});

test("buildOpenUrlCommand picks the native browser launcher for each platform", () => {
  assert.deepEqual(buildOpenUrlCommand("https://example.com", "darwin"), {
    command: "open",
    args: ["https://example.com"]
  });
  assert.deepEqual(buildOpenUrlCommand("https://example.com", "win32"), {
    command: "cmd",
    args: ["/c", "start", "", "https://example.com"]
  });
  assert.deepEqual(buildOpenUrlCommand("https://example.com", "linux"), {
    command: "xdg-open",
    args: ["https://example.com"]
  });
  assert.equal(buildOpenUrlCommand("file:///tmp/test", "darwin"), null);
});

test("openExternalUrl spawns the browser opener without blocking the UI", () => {
  const calls = [];
  const ok = openExternalUrl("https://example.com/docs", {
    platform: "darwin",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return { unref() {} };
    }
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [
    {
      command: "open",
      args: ["https://example.com/docs"],
      options: { stdio: "ignore", detached: true }
    }
  ]);
});

test("buildChatViewport can scroll back through long chat history", () => {
  const messages = [
    { id: "msg-1", role: "assistant", text: "첫 번째 긴 응답입니다. ".repeat(6) },
    { id: "msg-2", role: "assistant", text: "두 번째 긴 응답입니다. ".repeat(6) }
  ];
  const latest = buildChatViewport(messages, {
    maxLines: 4,
    widthChars: 24
  });
  const scrolled = buildChatViewport(messages, {
    maxLines: 4,
    widthChars: 24,
    scrollOffset: latest.maxScrollOffset
  });

  assert.ok(latest.maxScrollOffset > 0);
  assert.match(latest.visibleMessages.at(-1)?.text || "", /두\s*번|째 긴 응답/);
  assert.match(scrolled.visibleMessages[0]?.text || "", /첫 번째|…/);
});

test("buildChatViewport expands a focused long assistant reply", () => {
  const messages = [
    { id: "msg-1", role: "assistant", text: "abcdef".repeat(14) }
  ];
  const collapsed = buildChatViewport(messages, {
    maxLines: 6,
    widthChars: 24,
    focusedMessageId: "msg-1"
  });
  const expanded = buildChatViewport(messages, {
    maxLines: 6,
    widthChars: 24,
    focusedMessageId: "msg-1",
    expandedMessageIds: new Set(["msg-1"])
  });

  assert.deepEqual(collapsed.collapsibleMessageIds, ["msg-1"]);
  assert.match(collapsed.visibleMessages[0].text, /더 있음/);
  assert.ok(!expanded.visibleMessages[0].text.includes("더 있음"));
});

test("buildListViewport can scroll through long list items", () => {
  const lines = [
    "#1 " + "메모 내용을 길게 적습니다. ".repeat(6),
    "#2 짧은 메모"
  ];
  const top = buildListViewport(lines, {
    title: "memo",
    maxLines: 4,
    widthChars: 24
  });
  const scrolled = buildListViewport(lines, {
    title: "memo",
    maxLines: 4,
    widthChars: 24,
    scrollOffset: top.maxScrollOffset
  });

  assert.ok(top.maxScrollOffset > 0);
  assert.match(top.visibleItems[0].text, /#1|메모 내용|더 있음/);
  assert.match(scrolled.visibleItems.at(-1)?.text || "", /#2 짧은 메모|짧은 메모/);
});

test("buildListViewport expands a focused long list item", () => {
  const lines = [
    "[ ] 1. " + "할 일 내용을 길게 적습니다. ".repeat(7)
  ];
  const collapsed = buildListViewport(lines, {
    title: "todo",
    maxLines: 6,
    widthChars: 24,
    focusedItemId: "todo-0"
  });
  const expanded = buildListViewport(lines, {
    title: "todo",
    maxLines: 6,
    widthChars: 24,
    focusedItemId: "todo-0",
    expandedItemIds: new Set(["todo-0"])
  });

  assert.deepEqual(collapsed.collapsibleItemIds, ["todo-0"]);
  assert.match(collapsed.visibleItems[0].text, /더 있음/);
  assert.ok(!expanded.visibleItems[0].text.includes("더 있음"));
});

test("buildListViewport does not collapse long github lines and relies on panel scrolling instead", () => {
  const lines = [
    "review · very long repository name and pull request title that should wrap across many lines ".repeat(3)
  ];

  const viewport = buildListViewport(lines, {
    title: "github",
    maxLines: 4,
    widthChars: 24
  });

  assert.deepEqual(viewport.collapsibleItemIds, []);
  assert.ok(!viewport.visibleItems[0].text.includes("더 있음"));
  assert.ok(viewport.maxScrollOffset > 0);
});

test("resolveChatHotkey prefers modified arrow bindings with ctrl fallbacks", () => {
  assert.equal(resolveChatHotkey("", { alt: true, upArrow: true }), "scroll_up");
  assert.equal(resolveChatHotkey("", { alt: true, downArrow: true }), "scroll_down");
  assert.equal(resolveChatHotkey("", { alt: true, leftArrow: true }), "focus_prev");
  assert.equal(resolveChatHotkey("", { alt: true, rightArrow: true }), "focus_next");
  assert.equal(resolveChatHotkey("o", { alt: true }), "toggle_expand");
  assert.equal(resolveChatHotkey("o", { meta: true }), "toggle_expand");
  assert.equal(resolveChatHotkey("b", { ctrl: true }), "scroll_up");
  assert.equal(resolveChatHotkey("f", { ctrl: true }), "scroll_down");
});

test("resolveViewHotkey supports function keys and alt digit fallbacks", () => {
  assert.equal(resolveViewHotkey("\u001bOP", {}), "chat");
  assert.equal(resolveViewHotkey("\u001bOQ", {}), "memo");
  assert.equal(resolveViewHotkey("\u001bOR", {}), "todo");
  assert.equal(resolveViewHotkey("\u001bOS", {}), "schedule");
  assert.equal(resolveViewHotkey("\u001b[15~", {}), "github");
  assert.equal(resolveViewHotkey("\u001b1", { alt: true }), "chat");
  assert.equal(resolveViewHotkey("\u001b5", { alt: true }), "github");
});

test("input bar ignores modified hotkeys reserved for navigation and expand", () => {
  assert.equal(shouldHandleInputBarKey("o", { ctrl: true }), false);
  assert.equal(shouldHandleInputBarKey("", { alt: true, leftArrow: true }), false);
  assert.equal(shouldHandleInputBarKey("", { meta: true, rightArrow: true }), false);
  assert.equal(shouldHandleInputBarKey("a", { ctrl: true }), true);
  assert.equal(shouldHandleInputBarKey("e", { ctrl: true }), true);
  assert.equal(shouldHandleInputBarKey("", { leftArrow: true }), true);
});

test("parseMouseSequence parses SGR click and wheel events", () => {
  assert.deepEqual(parseMouseSequence("\u001b[<0;12;4M"), [
    { kind: "press", button: "left", x: 12, y: 4 }
  ]);
  assert.deepEqual(parseMouseSequence("\u001b[<64;20;8M"), [
    { kind: "wheel_up", x: 20, y: 8 }
  ]);
});

test("resolveMouseAction switches tabs on click", () => {
  const action = resolveMouseAction(
    { kind: "press", button: "left", x: 12, y: 4 },
    {
      layout: calculateResponsiveLayout(120, 30),
      activeView: "chat",
      tabs: buildViewTabs("chat")
    }
  );

  assert.deepEqual(action, { type: "switch_view", view: "memo" });
});

test("resolveMouseAction maps wheel to chat scrolling", () => {
  const action = resolveMouseAction(
    { kind: "wheel_up", x: 40, y: 15 },
    {
      layout: calculateResponsiveLayout(120, 30),
      activeView: "chat",
      tabs: buildViewTabs("chat"),
      chatViewport: { visibleMessages: [] }
    }
  );

  assert.deepEqual(action, { type: "chat_scroll_up" });
});

test("resolveMouseAction focuses and toggles a collapsible chat message", () => {
  const layout = calculateResponsiveLayout(120, 30);
  const viewport = {
    visibleMessages: [
      {
        id: "msg-1",
        text: "line1\nline2\nline3",
        isCollapsible: true
      }
    ],
    focusedMessageId: null
  };

  const focusAction = resolveMouseAction(
    { kind: "press", button: "left", x: 30, y: 12 },
    {
      layout,
      activeView: "chat",
      tabs: buildViewTabs("chat"),
      chatViewport: viewport
    }
  );
  assert.deepEqual(focusAction, { type: "focus_message", id: "msg-1" });

  const toggleAction = resolveMouseAction(
    { kind: "press", button: "left", x: 30, y: 12 },
    {
      layout,
      activeView: "chat",
      tabs: buildViewTabs("chat"),
      chatViewport: { ...viewport, focusedMessageId: "msg-1" }
    }
  );
  assert.deepEqual(toggleAction, { type: "toggle_message", id: "msg-1" });
});

test("resolveMouseAction opens a clicked hyperlink inside a chat reply", () => {
  const layout = calculateResponsiveLayout(120, 30);
  const action = resolveMouseAction(
    { kind: "press", button: "left", x: 46, y: 12 },
    {
      layout,
      activeView: "chat",
      tabs: buildViewTabs("chat"),
      chatViewport: {
        visibleMessages: [
          {
            id: "msg-1",
            text: "doc https://example.com/docs",
            isCollapsible: false
          }
        ],
        focusedMessageId: null
      }
    }
  );

  assert.deepEqual(action, { type: "open_link", url: "https://example.com/docs" });
});

test("resolveMouseAction uses display width when a Korean prefix appears before a link", () => {
  const layout = calculateResponsiveLayout(120, 30);
  const viewport = {
    visibleMessages: [
      {
        id: "msg-1",
        text: "문서 https://example.com/docs",
        isCollapsible: false
      }
    ],
    focusedMessageId: null
  };

  const prefixAction = resolveMouseAction(
    { kind: "press", button: "left", x: 44, y: 12 },
    {
      layout,
      activeView: "chat",
      tabs: buildViewTabs("chat"),
      chatViewport: viewport
    }
  );
  assert.equal(prefixAction, null);

  const linkAction = resolveMouseAction(
    { kind: "press", button: "left", x: 46, y: 12 },
    {
      layout,
      activeView: "chat",
      tabs: buildViewTabs("chat"),
      chatViewport: viewport
    }
  );
  assert.deepEqual(linkAction, { type: "open_link", url: "https://example.com/docs" });
});
