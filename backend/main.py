from fastapi import FastAPI

from backend.routers.chat import router as chat_router
from backend.routers.github import router as github_router
from backend.routers.web import router as web_router


app = FastAPI(
    title="NekoDesk Backend",
    version="0.1.0",
    description="FastAPI backend for NekoDesk LLM orchestration and GitHub aggregation.",
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(chat_router)
app.include_router(github_router)
app.include_router(web_router)
