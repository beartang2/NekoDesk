import { useState, useCallback, useRef } from "react";
import { conversationApi } from "../api/tauri";
import { appEvents } from "../lib/events";
import { useMessageStore } from "../stores/messageStore";
import { runAgentLoop } from "../agent/agent-loop";
import type { AgentStep, CatEmotion, ContentPart, LlmMessage, LoopEvent } from "../agent/types";

export interface PendingConfirm {
  sessionId: string;
  language: string;
  code: string;
  isDangerous: boolean;
  dangerReason: string;
  resolve: (ok: boolean) => void;
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
  attachments?: AttachedFile[];
  images?: string[];
}

function nowTime(): string {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function stripSpecialTokens(text: string): { clean: string; emotion: CatEmotion | null; gameOver: boolean } {
  const match = text.match(/\[\[PET_STATE:(\w+)\]\]/);
  const emotion = match ? (match[1] as CatEmotion) : null;
  const gameOver = text.includes("[[GAME_OVER]]");
  const clean = text
    .replace(/\[\[PET_STATE:\w+\]\]/g, "")
    .replace(/\[\[GAME_OVER\]\]/g, "")
    .trim();
  return { clean, emotion, gameOver };
}

// Text-only representation (for DB storage and system prompt context)
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
        : m.content,
    }));
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
export function useAgentPool() {
  // 메시지 상태는 messageStore 소유. 비동기 루프는 getState() 로 최신값을 읽어
  // 예전 allMessagesRef 미러링 해킹이 필요 없다.
  // Use a ref for fast reads inside async loops, and state for UI reactivity
  const runningSetRef = useRef<Set<string>>(new Set());
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  const [catEmotions, setCatEmotions] = useState<Record<string, CatEmotion>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [sessionTokens, setSessionTokens] = useState<Record<string, number>>({});
  // 예전에는 boolean 플래그였다. 플래그는 소비 루프만 멈출 뿐 진행 중인
  // fetch 를 끊지 못해, stop 을 눌러도 llama.cpp 는 끝까지 GPU 를 물고 있었다.
  const abortRefs = useRef<Record<string, AbortController | undefined>>({});
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [pendingClarify, setPendingClarify] = useState<PendingClarify | null>(null);

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
    async (sessionId: string, userText: string, files: AttachedFile[] = [], displayText?: string, summaryContext?: string) => {
      if (runningSetRef.current.has(sessionId)) return;

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
      };
      const assistantId = crypto.randomUUID();
      const placeholder: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        time: nowTime(),
        steps: [],
        isStreaming: true,
      };

      patchSessionMessages(sessionId, (prev) => [...prev, userMsg, placeholder]);

      const textContent = buildTextContent(userText, files);
      const llmContent = buildLlmContent(userText, files);
      conversationApi.save(sessionId, "user", buildTextContent(visibleText, files)).catch(() => {});

      const rawHistory = buildHistory(useMessageStore.getState().get(sessionId));
      const history: LlmMessage[] = summaryContext
        ? [{ role: "user", content: `[이전 대화 요약]\n${summaryContext}` }, { role: "assistant", content: "알겠어, 이전 내용 참고할게." }, ...rawHistory]
        : rawHistory;
      const generator = runAgentLoop(textContent, history, llmContent, controller.signal);

      let finalSteps: AgentStep[] = [];
      let streamBuffer = "";

      function handleEvent(event: LoopEvent) {
        switch (event.type) {
          case "step_start":
            setCatEmotion(sessionId, "curious");
            break;

          case "thinking_token":
            // 생각 문장은 화면에 보여주지 않는다(말풍선엔 고정 "생각 중…"). 고양이 표정만 바꾼다.
            setCatEmotion(sessionId, "working");
            break;

          case "step_done":
            finalSteps = [...finalSteps, event.step];
            setCatEmotion(sessionId, "working");
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, steps: [...finalSteps] } : m
              )
            );
            break;

          case "step_error":
            finalSteps = [...finalSteps, event.step];
            setCatEmotion(sessionId, "error");
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, steps: [...finalSteps] } : m
              )
            );
            break;

          case "streaming_token":
            streamBuffer += event.token;
            setCatEmotion(sessionId, "working");
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: streamBuffer
                        .replace(/\[\[PET_STATE:\w+\]\]/g, "")
                        .replace(/\[\[GAME_OVER\]\]/g, "")
                        .trimStart(),
                    }
                  : m
              )
            );
            break;

          case "confirm_needed":
            setPendingConfirm({
              sessionId,
              language: event.language,
              code: event.code,
              isDangerous: event.isDangerous,
              dangerReason: event.dangerReason,
              resolve: event.resolve,
            });
            break;

          case "clarify_needed":
            setPendingClarify({
              sessionId,
              question: event.question,
              options: event.options,
              resolve: event.resolve,
            });
            break;

          case "done": {
            finalSteps = event.steps;
            if (event.promptTokens !== undefined) {
              setSessionTokens((prev) => ({
                ...prev,
                [sessionId]: Math.max(prev[sessionId] ?? 0, event.promptTokens!),
              }));
            }
            const { clean, emotion, gameOver } = stripSpecialTokens(event.answer);
            if (gameOver) {
              appEvents.emit("wordchainGameover");
            }
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
                  ? { ...m, content: clean, steps: finalSteps, isStreaming: false, images: images.length > 0 ? images : undefined }
                  : m
              )
            );
            conversationApi.save(sessionId, "assistant", clean).catch(() => {});
            appEvents.emit("agentDone");
            break;
          }

          case "error":
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
    },
    // patchSessionMessages / setRunning / setCatEmotion are defined in render scope
    // but don't capture stale state — they use functional setters or refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const stop = useCallback(
    (sessionId: string) => {
      // 진행 중인 fetch 를 실제로 끊는다. llama.cpp 가 생성을 중단한다.
      abortRefs.current[sessionId]?.abort();
      setRunning(sessionId, false);
      setCatEmotion(sessionId, "idle");
      setPendingClarify((prev) => (prev?.sessionId === sessionId ? null : prev));
      setPendingConfirm((prev) => (prev?.sessionId === sessionId ? null : prev));
      useMessageStore.getState().patch(sessionId, (msgs) =>
        msgs.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
      );
    },
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
    pendingConfirm,
    confirmResolve: (ok: boolean) => {
      pendingConfirm?.resolve(ok);
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
