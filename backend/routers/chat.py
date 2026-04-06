from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


router = APIRouter(tags=["chat"])


def load_env_files() -> None:
    repo_root = Path(__file__).resolve().parents[2]

    for env_path in (repo_root / ".env", repo_root / "backend" / ".env"):
        if not env_path.exists():
            continue

        for line in env_path.read_text(encoding="utf-8").splitlines():
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#") or "=" not in trimmed:
                continue

            key, raw_value = trimmed.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue

            os.environ[key] = strip_quotes(raw_value.strip())


def strip_quotes(value: str) -> str:
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]

    return value


load_env_files()


def normalize_model_name(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        return trimmed

    basename = trimmed.replace("~/", "", 1).replace("\\", "/").rsplit("/", 1)[-1]
    if basename.lower().endswith(".gguf"):
        return basename[:-5]

    return trimmed

LLAMA_CPP_BASE_URL = (
    os.getenv("NEKODESK_LLAMA_BASE_URL")
    or os.getenv("NEKODESK_LLM_URL")
    or "http://127.0.0.1:8803"
).rstrip("/")
LLAMA_CPP_API_PATH = (
    os.getenv("NEKODESK_LLAMA_API_PATH")
    or os.getenv("NEKODESK_LLM_API_PATH")
    or "/v1/chat/completions"
)
DEFAULT_MODEL = normalize_model_name(os.getenv("NEKODESK_LLM_MODEL", "Qwen3 8B Q4_K_M"))
DEFAULT_TIMEOUT_MS = int(os.getenv("NEKODESK_LLM_TIMEOUT_MS", "12000"))


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    system_prompt: str
    messages: list[ChatMessage] = Field(default_factory=list)
    model: str = DEFAULT_MODEL
    temperature: float = 0.3
    max_tokens: int | None = None
    active_view: str = "chat"
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    current_datetime: str | None = None
    timezone: str = "UTC"
    headers: dict[str, str] = Field(default_factory=dict)
    request_body: dict = Field(default_factory=dict)


class ChatResponse(BaseModel):
    content: str
    mode: Literal["default"] = "default"
    provider: Literal["llama.cpp"] = "llama.cpp"


class EmptyLlamaResponseError(RuntimeError):
    pass


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    try:
        content = await call_llama_cpp(
            system_prompt=request.system_prompt,
            messages=[message.model_dump() for message in request.messages],
            model=request.model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            timeout_ms=request.timeout_ms,
            extra_headers=request.headers,
            extra_body=request.request_body,
        )

        if not content:
            raise HTTPException(status_code=502, detail="llama.cpp returned an empty response")

        return ChatResponse(content=content)
    except HTTPException:
        raise
    except EmptyLlamaResponseError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail=f"llama.cpp timed out after {request.timeout_ms}ms") from error
    except httpx.HTTPStatusError as error:
        raise HTTPException(
            status_code=502,
            detail=f"llama.cpp returned HTTP {error.response.status_code}",
        ) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"failed to reach llama.cpp: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"chat orchestration failed: {error}") from error


async def call_llama_cpp(
    *,
    system_prompt: str,
    messages: list[dict[str, str]],
    model: str,
    temperature: float,
    max_tokens: int | None,
    timeout_ms: int,
    extra_headers: dict[str, str],
    extra_body: dict,
) -> str:
    body = {
        **extra_body,
        "model": model,
        "temperature": temperature,
        "messages": [{"role": "system", "content": system_prompt}, *messages],
    }

    if max_tokens is not None:
        body["max_tokens"] = max_tokens

    async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
        response = await client.post(
            resolve_llama_cpp_url(),
            headers={"Content-Type": "application/json", **extra_headers},
            json=body,
        )
        response.raise_for_status()
        payload = response.json()
        message = (payload.get("choices", [{}])[0].get("message", {}) or {})
        content = (message.get("content") or "").strip()
        if content:
            return content

        reasoning_content = (message.get("reasoning_content") or "").strip()
        if reasoning_content:
            raise EmptyLlamaResponseError(
                "llama.cpp returned reasoning_content without a final answer; restart llama-server with --reasoning off --reasoning-format none"
            )

        return ""


def resolve_llama_cpp_url() -> str:
    return f"{LLAMA_CPP_BASE_URL}{LLAMA_CPP_API_PATH}"
