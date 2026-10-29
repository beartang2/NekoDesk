import { invoke } from "@tauri-apps/api/core";
import { getServerToolCaps, setServerToolCaps, type ServerToolCaps } from "../stores/settingsStore";

/**
 * 모델이 서버 툴(웹 검색·페이지 읽기)을 지원하는지 Models API 에 묻는다.
 *
 * 공식 문서는 모델별 지원 여부를 표로 주지 않고 `capabilities.server_tools.<tool>.supported`
 * 를 보라고 한다. 한 번 물어 settingsStore 에 두면 buildToolSchemas 가 겹치는 로컬 툴을 빼고
 * llm-transport 가 서버 툴을 붙인다. 못 물어보면(키 없음·네트워크) 로컬 툴 그대로다.
 */
export function parseServerToolCaps(json: unknown): ServerToolCaps {
  const caps = (json as { capabilities?: { server_tools?: Record<string, { supported?: unknown }> } })
    ?.capabilities?.server_tools ?? {};
  const on = (name: string) => caps[name]?.supported === true;
  return { web_search: on("web_search"), web_fetch: on("web_fetch") };
}

export async function refreshServerToolCaps(model: string, force = false): Promise<ServerToolCaps | null> {
  if (!force) {
    const known = getServerToolCaps(model);
    if (known) return known;
  }
  try {
    const [status, text] = await invoke<[number, string]>("claude_get", { path: `/v1/models/${encodeURIComponent(model)}` });
    if (status !== 200) return null;
    const caps = parseServerToolCaps(JSON.parse(text));
    setServerToolCaps(model, caps);
    return caps;
  } catch {
    return null;
  }
}
