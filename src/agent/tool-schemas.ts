import { getAllTools } from "./tool-registry";
import { getMcpTools } from "./mcp-registry";
import type { JsonSchema, JsonSchemaProp, OpenAiToolSchema } from "./types";

/**
 * 툴 목록을 **한 소스에서** 두 표현으로 뽑는다.
 *
 *  - `buildToolSchemas()`  → native tool calling 의 `tools` 배열
 *  - `describeToolsForPrompt()` → json 폴백 모드의 프롬프트 텍스트
 *
 * 예전에는 프롬프트용 설명(`STATIC_TOOLS_DESC`)을 llm-client 안에 손으로 적어둬서
 * registry 에 툴을 추가해도 모델은 모르는 상태가 될 수 있었다.
 */

/** 정적 registry + 로드된 MCP 툴 → OpenAI `tools` 배열. */
export function buildToolSchemas(): OpenAiToolSchema[] {
  const staticSchemas: OpenAiToolSchema[] = getAllTools().map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.params },
  }));

  const mcpSchemas: OpenAiToolSchema[] = getMcpTools().map((e) => ({
    type: "function",
    function: {
      name: e.tool.name,
      description: `${e.tool.description} [MCP:${e.serverName}]`,
      parameters: normalizeMcpSchema(e.tool.inputSchema),
    },
  }));

  return [...staticSchemas, ...mcpSchemas];
}

/**
 * MCP 서버가 준 inputSchema 를 그대로 믿지 않는다. 서버마다 형태가 제각각이고,
 * `properties` 가 없거나 type 이 빠진 스키마를 그대로 보내면 llama.cpp 의 문법
 * 컴파일이 실패해 요청 전체가 400 이 된다.
 */
function normalizeMcpSchema(input: {
  type?: string;
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
} | undefined): JsonSchema {
  const properties: Record<string, JsonSchemaProp> = {};
  for (const [key, value] of Object.entries(input?.properties ?? {})) {
    properties[key] = {
      type: isKnownType(value?.type) ? value.type : "string",
      ...(value?.description ? { description: value.description } : {}),
    };
  }
  const required = (input?.required ?? []).filter((k) => k in properties);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

const KNOWN_TYPES = ["string", "number", "boolean", "array", "object"] as const;

function isKnownType(t: string | undefined): t is JsonSchemaProp["type"] {
  return !!t && (KNOWN_TYPES as readonly string[]).includes(t);
}

/**
 * json 폴백 모드용 텍스트. native 스키마와 같은 registry 에서 생성하므로 둘이
 * 어긋나지 않는다. 예: `- todo.add: 할 일을 추가한다 (params: { "content": string (필수), ... })`
 */
export function describeToolsForPrompt(): string {
  return buildToolSchemas()
    .map(({ function: fn }) => {
      const required = new Set(fn.parameters.required ?? []);
      const props = Object.entries(fn.parameters.properties);
      const paramStr = props.length
        ? props
            .map(([key, prop]) => {
              const type = prop.enum ? prop.enum.map((v) => `"${v}"`).join(" | ") : prop.type;
              return `"${key}": ${type}${required.has(key) ? " (필수)" : ""}`;
            })
            .join(", ")
        : "";
      return `- ${fn.name}: ${fn.description} (params: { ${paramStr} })`;
    })
    .join("\n");
}
