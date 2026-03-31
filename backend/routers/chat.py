from __future__ import annotations

import os
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


router = APIRouter(tags=["chat"])


LLAMA_CPP_BASE_URL = os.getenv("NEKODESK_LLAMA_BASE_URL", "http://127.0.0.1:8803").rstrip("/")
LLAMA_CPP_API_PATH = os.getenv("NEKODESK_LLAMA_API_PATH", "/v1/chat/completions")
DEFAULT_MODEL = os.getenv("NEKODESK_LLM_MODEL", "Qwen3 8B Q4_K_M")
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
        return (payload.get("choices", [{}])[0].get("message", {}) or {}).get("content", "").strip()


def resolve_llama_cpp_url() -> str:
    return f"{LLAMA_CPP_BASE_URL}{LLAMA_CPP_API_PATH}"
