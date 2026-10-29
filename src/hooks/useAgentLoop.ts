import { useState, useCallback, useEffect, useRef } from "react";
import { conversationApi } from "../api/tauri";
import { appEvents } from "../lib/events";
import { notifyIfAway, toNotificationBody } from "../lib/notify";
import { useMessageStore } from "../stores/messageStore";
import { runAgentLoop, runTextTask } from "../agent/agent-loop";
import type {
  AgentStep,
  CatEmotion,
  ContentPart,
  LlmMessage,
  LoopEvent,
  PermissionDecision,
  ToolName,
} from "../agent/types";
import type { PlanStep } from "../agent/plan";

export interface PendingConfirm {
  sessionId: string;
  /** 코드면 언어("python"/"shell"/...), 파일이면 "write"/"edit". */
  language: string;
  /** 보여줄 본문 — 실행할 코드 또는 파일 변경 요약. */
  code: string;
  isDangerous: boolean;
  dangerReason: string;
  externalSendReason: string;
  /** "이 세션 동안"/"항상" 을 고르면 저장될 규칙. 버튼 라벨에도 쓴다. null 이면 기억 불가. */
  ruleKey: string | null;
  canRemember: boolean;
  resolve: (decision: PermissionDecision) => void;
}

export interface PendingClarify {
  sessionId: string;
  question: string;
  options: string[];
  resolve: (answer: string) => void;
}

export interface AttachedFile {
  name: string;
  content: string; // text content; empty for binary files
  dataUrl?: string; // base64 data URL for image files
  size: number;
  type: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  time: string;
  steps?: AgentStep[];
  isStreaming?: boolean;
  thinking?: string; // 답변이 나오기 전 실시간으로 흐르는 "생각"(thought)
  attachments?: AttachedFile[];
  images?: string[];
  /** 에이전트가 세운 작업 계획. 없으면 계획을 안 세운 요청이다. */
  plan?: PlanStep[];
  /** 답변 생성 속도(tok/s). 저장하지 않아 불러온 대화엔 없다. */
  tokensPerSecond?: number;
  /** 답 칸을 연 시각(ms). "생각하는 중" 타이머가 대화를 오가도 이어서 세게 한다. */
  startedAt?: number;
  /** 앱이 붙이는 안내(예: 반복돼서 끊음). 본문이 아니라 대화 기록에 안 실린다. */
  notice?: string;
  /** 사용자 말풍선 위에 작게 보이는 꼬리표(빠른 질문의 요약·번역·설명). */
  label?: string;
}

/** 대화 루프 대신 지시 하나로만 시키는 짧은 글 일(runTextTask). 빠른 질문의 버튼. */
export interface TextTask {
  label: string;
  system: string;
}

function nowTime(): string {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 화면·저장에 넣기 전에 답을 다듬는다.
 *
 * 모델이 가끔 `<mark>기억 저장:</mark>` 같은 HTML 을 쓴다. 화면은 HTML 을 그리지 않아
 * 태그가 글자로 보였다. 강조하려던 뜻은 살려 굵게로 바꾼다. 저장 전에 바꿔야 대화
 * 기록으로 돌아가 모델이 따라 쓰지 않는다.
 */
export function cleanAnswer(text: string): string {
  return text
    .replace(/\[\[PET_STATE:\w+\]\]/g, "")
    .replace(/<mark>([\s\S]*?)<\/mark>/g, (_, inner: string) => `**${inner.trim()}**`)
    .replace(/<\/?mark>/g, "");
}

function stripSpecialTokens(text: string): { clean: string; emotion: CatEmotion | null } {
  const match = text.match(/\[\[PET_STATE:(\w+)\]\]/);
  const emotion = match ? (match[1] as CatEmotion) : null;
  return { clean: cleanAnswer(text).trim(), emotion };
}

/**
 * 대화와 함께 저장할 첨부. 껐다 켠 뒤에도 처음 보낸 모습(미리보기·파일 카드)으로 되살린다.
 *
 * 메시지 본문은 보낸 글 그대로 저장하고, 텍스트 파일 내용은 여기에 둔다. 예전엔 본문 뒤에
 * "첨부 파일:" 으로 붙여 저장해서, 다시 불러오면 그 목록이 말풍선에 글로 보였다
 * (그렇게 저장된 대화는 splitAttachmentSection 이 되돌린다). 이미지 데이터는 크니까
 * 한 메시지당 총량을 제한하고, 넘치면 미리보기 없이 파일 카드로만 남긴다.
 */
const MAX_STORED_ATTACHMENT_BYTES = 2_000_000;

export function serializeAttachments(files: AttachedFile[]): string | undefined {
  if (files.length === 0) return undefined;
  let budget = MAX_STORED_ATTACHMENT_BYTES;
  const stored = files.map((f) => {
    const dataUrl = f.dataUrl && f.dataUrl.length <= budget ? f.dataUrl : undefined;
    if (dataUrl) budget -= dataUrl.length;
    return { name: f.name, type: f.type, size: f.size, content: f.content, ...(dataUrl ? { dataUrl } : {}) };
  });
  return JSON.stringify(stored);
}

/** 네코가 일하는 사이 사용자가 보낸 말. 끼워 넣거나 다음 요청으로 보낼 때까지 기다린다. */
export interface QueuedMessage {
  id: string;
  userText: string;
  files: AttachedFile[];
  displayText?: string;
  summaryContext?: string;
  requireTool?: ToolName;
  task?: TextTask;
}

/** 저장할 때 도구 파라미터·결과 한 칸의 최대 길이. 웹 페이지를 긁은 결과는 몇백 KB 다. */
const MAX_STORED_FIELD = 2000;

function clipForStore(value: unknown, max = MAX_STORED_FIELD): unknown {
  if (value === null || value === undefined) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return value;
  return `${text.slice(0, max)}… (${text.length - max}자 생략)`;
}

/** 답변과 함께 저장하는 것들. 없으면 그 칸을 비운다. */
export interface MessageMeta {
  steps?: AgentStep[];
  plan?: PlanStep[];
  thinking?: string;
  images?: string[];
  tokensPerSecond?: number;
  notice?: string;
  label?: string;
}

/**
 * 답변에 딸린 도구 기록·계획·생각·이미지를 저장용 JSON 으로 만든다.
 *
 * 예전엔 본문만 저장해서 다시 열면 "도구 N개 사용" 패널이 통째로 사라졌다.
 * 긴 칸은 잘라서 넣고, 이미지는 첨부와 같은 총량 안에서만 담는다.
 */
export function serializeMeta(meta: MessageMeta): string | undefined {
  let budget = MAX_STORED_ATTACHMENT_BYTES;
  const images = (meta.images ?? []).filter((url) => {
    if (url.length > budget) return false;
    budget -= url.length;
    return true;
  });
  const steps = (meta.steps ?? []).map(({ imageDataUrl: _image, ...s }) => ({
    ...s,
    // 중단돼서 "실행 중" 으로 남은 스텝을 다시 열면 영원히 돈다.
    ...(s.status === "running" ? { status: "error" as const, errorMessage: "중단됨" } : {}),
    params: Object.fromEntries(Object.entries(s.params ?? {}).map(([k, v]) => [k, clipForStore(v)])),
    result: clipForStore(s.result),
    summary: clipForStore(s.summary) as string,
  }));
  const stored: MessageMeta = {
    ...(steps.length ? { steps } : {}),
    ...(meta.plan?.length ? { plan: meta.plan } : {}),
    ...(meta.thinking ? { thinking: clipForStore(meta.thinking, 8000) as string } : {}),
    ...(images.length ? { images } : {}),
    ...(meta.tokensPerSecond !== undefined ? { tokensPerSecond: meta.tokensPerSecond } : {}),
    ...(meta.notice ? { notice: meta.notice } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  };
  return Object.keys(stored).length ? JSON.stringify(stored) : undefined;
}

export function parseMeta(raw: string | null | undefined): MessageMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as MessageMeta;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// 첨부를 글로 풀어 쓴 것 — 이미지가 없을 때 모델에 보내는 내용.
function buildTextContent(text: string, files: AttachedFile[]): string {
  if (files.length === 0) return text;
  const fileParts = files.map((f) => {
    if (f.dataUrl) {
      return `**${f.name}** (이미지)`;
    }
    if (!f.content) {
      return `**${f.name}** (바이너리 파일 — file.upload 툴로 업로드 가능. filename 파라미터: "${f.name}")`;
    }
    const ext = f.name.split(".").pop() ?? "";
    return `**${f.name}**\n\`\`\`${ext}\n${f.content}\n\`\`\``;
  });
  const section = fileParts.join("\n\n");
  return text ? `${text}\n\n---\n첨부 파일:\n\n${section}` : `첨부 파일:\n\n${section}`;
}

const ATTACHMENT_SECTION = "\n\n---\n첨부 파일:\n\n";
const ATTACHMENT_ONLY = "첨부 파일:\n\n";

/**
 * 예전 방식으로 저장된 메시지(본문 + "첨부 파일:" 목록)를 보낸 모습으로 되돌린다.
 *
 * 목록은 떼어 내고, 그 안에만 있던 텍스트 파일 내용은 첨부에 다시 넣는다 — 그래야 다시
 * 열어도 모델이 그 파일을 보고, 뷰어로도 열린다. 첨부 이름 순서대로 다음 이름 앞까지를
 * 그 파일 몫으로 자른다(파일 안에 코드 울타리가 있어도 다음 이름은 안 넘는다).
 */
export function splitAttachmentSection(
  content: string,
  files: AttachedFile[] | undefined
): { content: string; files: AttachedFile[] | undefined } {
  if (!files?.length) return { content, files };
  const at = content.indexOf(ATTACHMENT_SECTION);
  let text: string;
  let section: string;
  if (at >= 0) {
    text = content.slice(0, at);
    section = content.slice(at + ATTACHMENT_SECTION.length);
  } else if (content.startsWith(ATTACHMENT_ONLY)) {
    text = "";
    section = content.slice(ATTACHMENT_ONLY.length);
  } else {
    return { content, files };
  }
  const restored = files.map((f, i) => {
    if (f.dataUrl || f.content) return f;
    const head = `**${f.name}**\n\`\`\``;
    const s = section.indexOf(head);
    if (s < 0) return f;
    const bodyStart = section.indexOf("\n", s + head.length) + 1;
    const next = files[i + 1] ? section.indexOf(`\n\n**${files[i + 1].name}**`, bodyStart) : -1;
    const block = section.slice(bodyStart, next >= 0 ? next : section.length);
    const close = block.lastIndexOf("\n```");
    return { ...f, content: close >= 0 ? block.slice(0, close) : block };
  });
  return { content: text, files: restored };
}

// Multimodal content for LLM API (includes actual image data)
function buildLlmContent(text: string, files: AttachedFile[]): string | ContentPart[] {
  if (files.length === 0) return text;
  const hasImages = files.some((f) => f.dataUrl);
  if (!hasImages) return buildTextContent(text, files);

  const parts: ContentPart[] = [];
  if (text) parts.push({ type: "text", text });
  for (const f of files) {
    if (f.dataUrl) {
      parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      parts.push({ type: "text", text: `(파일명: ${f.name})` });
    } else if (f.content) {
      const ext = f.name.split(".").pop() ?? "";
      parts.push({ type: "text", text: `**${f.name}**\n\`\`\`${ext}\n${f.content}\n\`\`\`` });
    } else {
      parts.push({ type: "text", text: `**${f.name}** (바이너리 파일)` });
    }
  }
  return parts;
}

function buildHistory(messages: ChatMessage[]): LlmMessage[] {
  return messages
    .filter((m) => !m.isStreaming)
    .map((m) => ({
      role: m.role === "user" ? "user" : ("assistant" as const),
      content: m.attachments?.length
        ? buildLlmContent(m.content, m.attachments)
        : m.label
          ? `[${m.label}]\n${m.content}`
          : m.content || toolsOnlyNote(m),
    }));
}

/**
 * 사용자가 중간에 끼어들면 그때까지의 답 칸은 글 없이 도구 기록만 남기고 닫힌다.
 * 빈 assistant 메시지를 그대로 보내면 템플릿에 따라 거부되므로 한 줄로 적어 준다.
 */
function toolsOnlyNote(m: ChatMessage): string {
  if (m.role !== "assistant" || !m.steps?.length) return m.content;
  return `(도구 사용: ${[...new Set(m.steps.map((s) => s.tool))].join(", ")})`;
}

function deriveFinalEmotion(steps: AgentStep[]): CatEmotion {
  if (steps.some((s) => s.status === "error")) return "error";
  const writes = ["todo.add", "todo.complete", "schedule.add", "code.exec"];
  if (steps.some((s) => writes.includes(s.tool) && s.status === "done")) return "happy";
  if (steps.length > 0) return "proud";
  return "idle";
}

/**
 * Per-session agent pool — enables parallel processing across sessions.
 * Each session has its own isRunning / catEmotion / error / abortRef.
 */
// 마지막으로 잰 프롬프트 크기. 메모리에만 두면 껐다 켰을 때 대화는 DB 에서 그대로
// 돌아오는데 사용량만 0 으로 보였다. (지운 대화의 값이 남지만 숫자 하나라 둔다.)
const CONTEXT_TOKENS_KEY = "nekodesk_context_tokens";

function loadContextTokens(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(CONTEXT_TOKENS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function useAgentPool() {
  // 메시지 상태는 messageStore 소유. 비동기 루프는 getState() 로 최신값을 읽어
  // 예전 allMessagesRef 미러링 해킹이 필요 없다.
  // Use a ref for fast reads inside async loops, and state for UI reactivity
  const runningSetRef = useRef<Set<string>>(new Set());
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  const [catEmotions, setCatEmotions] = useState<Record<string, CatEmotion>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [sessionTokens, setSessionTokens] = useState<Record<string, number>>(loadContextTokens);
  useEffect(() => {
    localStorage.setItem(CONTEXT_TOKENS_KEY, JSON.stringify(sessionTokens));
  }, [sessionTokens]);
  // 예전에는 boolean 플래그였다. 플래그는 소비 루프만 멈출 뿐 진행 중인
  // fetch 를 끊지 못해, stop 을 눌러도 llama.cpp 는 끝까지 GPU 를 물고 있었다.
  const abortRefs = useRef<Record<string, AbortController | undefined>>({});
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [pendingClarify, setPendingClarify] = useState<PendingClarify | null>(null);
  // 일하는 사이 들어온 말. 루프가 도구 사이에 읽어 가므로 ref 가 원본이고 state 는 화면용이다.
  const queueRef = useRef<Record<string, QueuedMessage[]>>({});
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});

  function setQueue(id: string, next: QueuedMessage[]) {
    queueRef.current[id] = next;
    setQueues({ ...queueRef.current });
  }

  function setRunning(id: string, on: boolean) {
    if (on) runningSetRef.current.add(id);
    else runningSetRef.current.delete(id);
    setRunningSet(new Set(runningSetRef.current));
  }

  function setCatEmotion(id: string, emotion: CatEmotion) {
    setCatEmotions((prev) => ({ ...prev, [id]: emotion }));
  }

  const patchSessionMessages = (
    sessionId: string,
    action: React.SetStateAction<ChatMessage[]>
  ) => useMessageStore.getState().patch(sessionId, action);

  const sendMessage = useCallback(
    async (
      sessionId: string,
      userText: string,
      files: AttachedFile[] = [],
      displayText?: string,
      summaryContext?: string,
      requireTool?: ToolName,
      task?: TextTask
    ) => {
      // 일하는 중이면 버리지 않고 줄 세운다. 도구 사이에 끼워 넣거나(user_interjected),
      // 끼울 틈 없이 답이 끝나면 다음 요청으로 보낸다(아래 맨 끝).
      if (runningSetRef.current.has(sessionId)) {
        setQueue(sessionId, [
          ...(queueRef.current[sessionId] ?? []),
          { id: crypto.randomUUID(), userText, files, displayText, summaryContext, requireTool, task },
        ]);
        return;
      }

      abortRefs.current[sessionId]?.abort();
      const controller = new AbortController();
      abortRefs.current[sessionId] = controller;
      setRunning(sessionId, true);
      setCatEmotion(sessionId, "curious");
      setErrors((prev) => ({ ...prev, [sessionId]: null }));

      // displayText: UI와 DB에 보이는 텍스트 (생략 시 userText와 동일)
      // userText: LLM에 실제로 전달되는 텍스트 (게임 컨텍스트 등 포함 가능)
      const visibleText = displayText ?? userText;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: visibleText,
        time: nowTime(),
        attachments: files.length > 0 ? files : undefined,
        label: task?.label,
      };
      // 사용자가 끼어들면 답 칸을 새로 연다. 그때 바뀐다.
      let assistantId = crypto.randomUUID();
      const placeholder: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        time: nowTime(),
        steps: [],
        isStreaming: true,
        startedAt: Date.now(),
      };

      patchSessionMessages(sessionId, (prev) => [...prev, userMsg, placeholder]);

      const textContent = buildTextContent(userText, files);
      const llmContent = buildLlmContent(userText, files);
      conversationApi
        .save(sessionId, "user", visibleText, serializeAttachments(files), serializeMeta({ label: task?.label }))
        .catch(() => {});

      const rawHistory = buildHistory(useMessageStore.getState().get(sessionId));
      const history: LlmMessage[] = summaryContext
        ? [{ role: "user", content: `[이전 대화 요약]\n${summaryContext}` }, { role: "assistant", content: "알겠어, 이전 내용 참고할게." }, ...rawHistory]
        : rawHistory;
      // 루프가 도구 사이에 대기열을 비워 간다. 무엇을 가져갔는지는 곧이어 오는
      // user_interjected 에서 말풍선으로 옮긴다.
      // 버튼 일(task)은 끼워 넣지 않는다 — 지시 없이 고른 글만 들어가 무엇을 하라는 건지
      // 모른다. 줄에 남겨 두면 이번 답이 끝난 뒤 따로 돈다.
      let interjected: QueuedMessage[] = [];
      const takeInterjections = () => {
        const queued = queueRef.current[sessionId] ?? [];
        interjected = queued.filter((q) => !q.task);
        if (interjected.length > 0) setQueue(sessionId, queued.filter((q) => q.task));
        return interjected.map((q) => buildLlmContent(q.userText, q.files));
      };
      const hasInterjections = () => (queueRef.current[sessionId] ?? []).some((q) => !q.task);
      const generator = task
        ? runTextTask(task.system, userText, controller.signal)
        : runAgentLoop(textContent, history, llmContent, controller.signal, takeInterjections, requireTool, hasInterjections);

      // 지금 답 칸의 스텝. 끼어들기로 닫힌 칸의 스텝은 stepOffset 만큼 앞에 있다.
      let stepOffset = 0;
      let finalSteps: AgentStep[] = [];
      let streamBuffer = "";
      let thinkingBuffer = "";
      // done·error 에서 저장했는가. 아니면(중단) 루프가 끝난 뒤 그때까지의 것이라도 남긴다.
      let saved = false;

      function handleEvent(event: LoopEvent) {
        switch (event.type) {
          case "step_start":
            setCatEmotion(sessionId, "curious");
            thinkingBuffer = ""; // 새 스텝의 생각 시작
            // 앞 턴의 글이 아직 남아 있다면 답이 아니었다(재촉받고 다시 도는 중). 새 글이
            // 오면 그걸로 바꾼다 — 안 비우면 "찾아볼게" 뒤에 새 답이 이어 붙는다.
            streamBuffer = "";
            break;

          case "thinking_token":
            thinkingBuffer += event.token;
            setCatEmotion(sessionId, "working");
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, thinking: thinkingBuffer.trimStart() } : m
              )
            );
            break;

          case "plan_updated":
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, plan: event.steps } : m))
            );
            break;

          case "step_done":
            finalSteps = [...finalSteps, event.step];
            setCatEmotion(sessionId, "working");
            // 툴을 불렀으니 이번 턴 텍스트는 답이 아니라 중얼거림이다. 아코디언에
            // step.thought 로 이미 보인다. 안 비우면 턴마다 버블에 쌓인다.
            streamBuffer = "";
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, steps: [...finalSteps], content: "" } : m
              )
            );
            break;

          case "step_error":
            finalSteps = [...finalSteps, event.step];
            setCatEmotion(sessionId, "error");
            streamBuffer = "";
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, steps: [...finalSteps], content: "" } : m
              )
            );
            break;

          case "user_interjected": {
            // 지금까지의 도구 기록으로 답 칸을 닫고, 끼어든 말 뒤에 새 답 칸을 연다.
            // 한 칸에 이어 쓰면 답이 질문보다 위에 놓인다.
            const closedId = assistantId;
            const closed = useMessageStore.getState().get(sessionId).find((m) => m.id === closedId);
            const userMsgs = interjected.map((q): ChatMessage => ({
              id: crypto.randomUUID(),
              role: "user",
              content: q.displayText ?? q.userText,
              time: nowTime(),
              attachments: q.files.length > 0 ? q.files : undefined,
            }));
            assistantId = crypto.randomUUID();
            const next: ChatMessage = {
              id: assistantId,
              role: "assistant",
              content: "",
              time: nowTime(),
              steps: [],
              isStreaming: true,
              startedAt: Date.now(),
            };
            // 도구를 하나도 안 쓴 칸은 생성 도중 끊긴 것이다. 새 칸에서 처음부터 다시 답하니
            // 남기면 빈 칸이 된다 — 지운다.
            const keepClosed = finalSteps.length > 0;
            patchSessionMessages(sessionId, (prev) => [
              ...prev.flatMap((m) => (m.id !== closedId ? [m] : keepClosed ? [{ ...m, isStreaming: false }] : [])),
              ...userMsgs,
              next,
            ]);

            // 저장 순서가 곧 다시 열었을 때의 순서다. 명령이 스레드 풀에서 돌아 한꺼번에
            // 던지면 뒤바뀔 수 있으니 하나씩 잇는다.
            let chain = keepClosed
              ? conversationApi.save(sessionId, "assistant", "", undefined, serializeMeta({
                  steps: finalSteps,
                  plan: closed?.plan,
                  thinking: closed?.thinking,
                }))
              : Promise.resolve();
            for (const q of interjected) {
              chain = chain.then(() =>
                conversationApi.save(
                  sessionId,
                  "user",
                  q.displayText ?? q.userText,
                  serializeAttachments(q.files)
                )
              );
            }
            chain.catch(() => {});

            stepOffset = event.stepCount;
            finalSteps = [];
            streamBuffer = "";
            thinkingBuffer = "";
            break;
          }

          case "streaming_token":
            streamBuffer += event.token;
            setCatEmotion(sessionId, "working");
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: cleanAnswer(streamBuffer).trimStart(),
                    }
                  : m
              )
            );
            break;

          case "confirm_needed":
            // 딴 데 가 있으면 확인 창이 떠도 모른다. 대답할 때까지 루프가 멈춰 있다.
            void notifyIfAway("네코가 확인을 기다려", toNotificationBody(event.code, 120));
            setPendingConfirm({
              sessionId,
              language: event.language,
              code: event.code,
              isDangerous: event.isDangerous,
              dangerReason: event.dangerReason,
              externalSendReason: event.externalSendReason,
              ruleKey: event.ruleKey,
              canRemember: event.canRemember,
              resolve: event.resolve,
            });
            break;

          case "clarify_needed":
            void notifyIfAway("네코가 물어볼 게 있어", toNotificationBody(event.question, 120));
            setPendingClarify({
              sessionId,
              question: event.question,
              options: event.options,
              resolve: event.resolve,
            });
            break;

          case "done": {
            finalSteps = event.steps.slice(stepOffset);
            if (event.promptTokens !== undefined) {
              setSessionTokens((prev) => ({
                ...prev,
                [sessionId]: Math.max(prev[sessionId] ?? 0, event.promptTokens!),
              }));
            }
            const { clean, emotion } = stripSpecialTokens(event.answer);
            const images = finalSteps
              .map((s) => s.imageDataUrl)
              .filter((url): url is string => !!url);
            setCatEmotion(sessionId, emotion ?? deriveFinalEmotion(finalSteps));
            setRunning(sessionId, false);
            setPendingConfirm(null);
            setPendingClarify(null);
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: clean,
                      steps: finalSteps,
                      isStreaming: false,
                      images: images.length > 0 ? images : undefined,
                      plan: event.plan?.length ? event.plan : undefined,
                      tokensPerSecond: event.tokensPerSecond,
                      notice: event.notice,
                    }
                  : m
              )
            );
            saved = true;
            conversationApi
              .save(sessionId, "assistant", clean, undefined, serializeMeta({
                steps: finalSteps,
                plan: event.plan,
                thinking: thinkingBuffer.trimStart(),
                images,
                tokensPerSecond: event.tokensPerSecond,
                notice: event.notice,
              }))
              .catch(() => {});
            appEvents.emit("agentDone");
            void notifyIfAway("네코", toNotificationBody(clean));
            break;
          }

          case "error":
            // 화면에 남는 것과 같게 저장한다. 안 하면 다시 열었을 때 질문만 덩그러니 남는다.
            saved = true;
            conversationApi
              .save(sessionId, "assistant", `연결 실패: ${event.message}`, undefined, serializeMeta({ steps: finalSteps }))
              .catch(() => {});
            setCatEmotion(sessionId, "error");
            setRunning(sessionId, false);
            setPendingConfirm(null);
            setPendingClarify(null);
            setErrors((prev) => ({ ...prev, [sessionId]: event.message }));
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: `연결 실패: ${event.message}`, isStreaming: false }
                  : m
              )
            );
            break;
        }
      }

      // break 하면 generator 의 finally 가 돌아 스트림 리더까지 정리된다.
      for await (const event of generator) {
        if (controller.signal.aborted) break;
        handleEvent(event);
      }

      // 중단하면 done 이 안 온다. 예전엔 그래서 답이 통째로 안 남았다.
      if (!saved) {
        const partial = useMessageStore.getState().get(sessionId).find((m) => m.id === assistantId);
        if (partial?.content || finalSteps.length > 0) {
          conversationApi
            .save(sessionId, "assistant", partial?.content ?? "", undefined, serializeMeta({
              steps: finalSteps,
              plan: partial?.plan,
              thinking: thinkingBuffer.trimStart(),
            }))
            .catch(() => {});
        }
      }

      // 끼울 틈 없이 답이 끝났으면 기다리던 말을 다음 요청으로 보낸다. 멈춘 거라면 stop 이 이미
      // 보냈다 — 여기서 또 꺼내면 새 요청의 대기열을 가로챈다.
      // ponytail: 연결 오류로 끝나도 보낸다 — 줄 선 만큼 같은 오류가 이어진다.
      // 거슬리면 오류일 땐 대기열을 남겨 두고 사용자가 다시 보내게 한다.
      if (!controller.signal.aborted) sendWaiting(sessionId);
    },
    // patchSessionMessages / setRunning / setCatEmotion are defined in render scope
    // but don't capture stale state — they use functional setters or refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** 기다리던 말 가운데 맨 앞을 새 요청으로 보낸다. */
  function sendWaiting(sessionId: string) {
    const [waiting, ...rest] = queueRef.current[sessionId] ?? [];
    if (!waiting) return;
    setQueue(sessionId, rest);
    void sendMessage(sessionId, waiting.userText, waiting.files, waiting.displayText, waiting.summaryContext, waiting.requireTool, waiting.task);
  }

  const stop = useCallback(
    (sessionId: string) => {
      // 진행 중인 fetch 를 실제로 끊는다. llama.cpp 가 생성을 중단한다.
      abortRefs.current[sessionId]?.abort();
      setRunning(sessionId, false);
      setCatEmotion(sessionId, "idle");
      // 되묻는 중에 멈춰도 promise 를 풀어 준다. 안 그러면 루프가 대답을 영영 기다린다.
      setPendingClarify((prev) => {
        if (prev?.sessionId !== sessionId) return prev;
        prev.resolve("");
        return null;
      });
      // 확인 대기 중에 stop 을 누르면 promise 를 풀어줘야 한다. 안 그러면 제너레이터가
      // 영원히 await 에 매달려 abort 신호를 확인할 기회조차 못 갖는다.
      setPendingConfirm((prev) => {
        if (prev?.sessionId !== sessionId) return prev;
        prev.resolve("deny");
        return null;
      });
      useMessageStore.getState().patch(sessionId, (msgs) =>
        msgs.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
      );
      // 기다리던 말은 멈추자마자 보낸다. 멈춘 루프가 끝나기를 기다리면, 도구가 도는 중이거나
      // 기억을 떠올리는 중일 때(신호를 안 받는 일) 그게 끝날 때까지 안 나갔다.
      sendWaiting(sessionId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return {
    isRunning: (sessionId: string) => runningSet.has(sessionId),
    catEmotion: (sessionId: string): CatEmotion =>
      catEmotions[sessionId] ?? "idle",
    error: (sessionId: string): string | null => errors[sessionId] ?? null,
    clearError: (sessionId: string) =>
      setErrors((prev) => ({ ...prev, [sessionId]: null })),
    contextTokens: (sessionId: string): number => sessionTokens[sessionId] ?? 0,
    clearContextTokens: (sessionId: string) =>
      setSessionTokens((prev) => { const next = { ...prev }; delete next[sessionId]; return next; }),
    sendMessage,
    stop,
    /** 일하는 사이 보낸, 아직 네코가 못 읽은 말. */
    queued: (sessionId: string): QueuedMessage[] => queues[sessionId] ?? [],
    cancelQueued: (sessionId: string, id: string) =>
      setQueue(sessionId, (queueRef.current[sessionId] ?? []).filter((q) => q.id !== id)),
    pendingConfirm,
    confirmResolve: (decision: PermissionDecision) => {
      pendingConfirm?.resolve(decision);
      setPendingConfirm(null);
    },
    pendingClarify,
    clarifyResolve: (answer: string) => {
      pendingClarify?.resolve(answer);
      setPendingClarify(null);
    },
  };
}

export function makeInitialMessages(): ChatMessage[] {
  return [];
}
