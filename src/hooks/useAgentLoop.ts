import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runAgentLoop } from "../agent/agent-loop";
import type { AgentStep, CatEmotion, LlmMessage, LoopEvent } from "../agent/types";

export interface PendingConfirm {
  sessionId: string;
  language: string;
  code: string;
  isDangerous: boolean;
  dangerReason: string;
  resolve: (ok: boolean) => void;
}

export interface AttachedFile {
  name: string;
  content: string; // text content; empty for binary files
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
}

function nowTime(): string {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function stripPetToken(text: string): { clean: string; emotion: CatEmotion | null } {
  const match = text.match(/\[\[PET_STATE:(\w+)\]\]/);
  const emotion = match ? (match[1] as CatEmotion) : null;
  const clean = text.replace(/\[\[PET_STATE:\w+\]\]/g, "").trim();
  return { clean, emotion };
}

function buildUserContent(text: string, files: AttachedFile[]): string {
  if (files.length === 0) return text;
  const fileParts = files.map((f) => {
    if (!f.content) {
      return `**${f.name}** (바이너리 파일 — file.upload 툴로 업로드 가능. filename 파라미터: "${f.name}")`;
    }
    const ext = f.name.split(".").pop() ?? "";
    return `**${f.name}**\n\`\`\`${ext}\n${f.content}\n\`\`\``;
  });
  const section = fileParts.join("\n\n");
  return text ? `${text}\n\n---\n첨부 파일:\n\n${section}` : `첨부 파일:\n\n${section}`;
}

function buildHistory(messages: ChatMessage[]): LlmMessage[] {
  return messages
    .filter((m) => !m.isStreaming)
    .map((m) => ({
      role: m.role === "user" ? "user" : ("assistant" as const),
      content: m.attachments?.length
        ? buildUserContent(m.content, m.attachments)
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
export function useAgentPool(
  allMessagesRef: React.MutableRefObject<Record<string, ChatMessage[]>>,
  setAllMessages: React.Dispatch<React.SetStateAction<Record<string, ChatMessage[]>>>
) {
  // Use a ref for fast reads inside async loops, and state for UI reactivity
  const runningSetRef = useRef<Set<string>>(new Set());
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  const [catEmotions, setCatEmotions] = useState<Record<string, CatEmotion>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const abortRefs = useRef<Record<string, boolean>>({});
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  function setRunning(id: string, on: boolean) {
    if (on) runningSetRef.current.add(id);
    else runningSetRef.current.delete(id);
    setRunningSet(new Set(runningSetRef.current));
  }

  function setCatEmotion(id: string, emotion: CatEmotion) {
    setCatEmotions((prev) => ({ ...prev, [id]: emotion }));
  }

  function patchSessionMessages(
    sessionId: string,
    action: React.SetStateAction<ChatMessage[]>
  ) {
    setAllMessages((prev) => {
      const current = prev[sessionId] ?? [];
      const next = typeof action === "function" ? action(current) : action;
      return { ...prev, [sessionId]: next };
    });
  }

  const sendMessage = useCallback(
    async (sessionId: string, userText: string, files: AttachedFile[] = []) => {
      if (runningSetRef.current.has(sessionId)) return;

      abortRefs.current[sessionId] = false;
      setRunning(sessionId, true);
      setCatEmotion(sessionId, "curious");
      setErrors((prev) => ({ ...prev, [sessionId]: null }));

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: userText,
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

      const fullContent = buildUserContent(userText, files);
      invoke("conversation_save", {
        sessionId,
        role: "user",
        content: fullContent,
      }).catch(() => {});

      const history = buildHistory(allMessagesRef.current[sessionId] ?? []);
      const generator = runAgentLoop(fullContent, history);

      let finalSteps: AgentStep[] = [];
      let streamBuffer = "";

      function handleEvent(event: LoopEvent) {
        switch (event.type) {
          case "step_start":
            setCatEmotion(sessionId, "curious");
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

          case "done": {
            finalSteps = event.steps;
            const { clean, emotion } = stripPetToken(event.answer);
            setCatEmotion(sessionId, emotion ?? deriveFinalEmotion(finalSteps));
            setRunning(sessionId, false);
            setPendingConfirm(null);
            patchSessionMessages(sessionId, (prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: clean, steps: finalSteps, isStreaming: false }
                  : m
              )
            );
            invoke("conversation_save", {
              sessionId,
              role: "assistant",
              content: clean,
            }).catch(() => {});
            window.dispatchEvent(new CustomEvent("nekodesk:agent_done"));
            break;
          }

          case "error":
            setCatEmotion(sessionId, "error");
            setRunning(sessionId, false);
            setPendingConfirm(null);
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

      for await (const event of generator) {
        if (abortRefs.current[sessionId]) break;
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
      abortRefs.current[sessionId] = true;
      setRunning(sessionId, false);
      setCatEmotion(sessionId, "idle");
      setAllMessages((prev) => {
        const msgs = prev[sessionId] ?? [];
        const updated = msgs.map((m) =>
          m.isStreaming ? { ...m, isStreaming: false } : m
        );
        return { ...prev, [sessionId]: updated };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setAllMessages]
  );

  return {
    isRunning: (sessionId: string) => runningSet.has(sessionId),
    catEmotion: (sessionId: string): CatEmotion =>
      catEmotions[sessionId] ?? "idle",
    error: (sessionId: string): string | null => errors[sessionId] ?? null,
    sendMessage,
    stop,
    pendingConfirm,
    confirmResolve: (ok: boolean) => {
      pendingConfirm?.resolve(ok);
      setPendingConfirm(null);
    },
  };
}

export function makeInitialMessages(): ChatMessage[] {
  return [];
}
