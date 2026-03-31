from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, HTTPException, Query


router = APIRouter(prefix="/github", tags=["github"])


GITHUB_API_BASE_URL = os.getenv("GITHUB_API_URL", "https://api.github.com").rstrip("/")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")


@router.get("/prs")
async def list_pull_requests(per_page: int = Query(default=10, ge=1, le=50)) -> dict:
    await ensure_github_token()
    payload = await github_search(
        f"/search/issues?q=is:open+author:@me+is:pr&per_page={per_page}"
    )

    items = payload.get("items", [])
    return {
      "status": "ok",
      "count": payload.get("total_count", 0),
      "items": [format_issue_like_item(item) for item in items]
    }


@router.get("/issues")
async def list_issues(per_page: int = Query(default=10, ge=1, le=50)) -> dict:
    await ensure_github_token()
    payload = await github_search(
        f"/search/issues?q=is:open+assignee:@me+is:issue&per_page={per_page}"
    )

    items = payload.get("items", [])
    return {
      "status": "ok",
      "count": payload.get("total_count", 0),
      "items": [format_issue_like_item(item) for item in items]
    }


@router.get("/commits")
async def list_recent_commits(
    per_repo: int = Query(default=3, ge=1, le=20),
    repo_limit: int = Query(default=5, ge=1, le=20),
) -> dict:
    await ensure_github_token()
    repositories = await github_request(f"/user/repos?sort=updated&per_page={repo_limit}")

    results = []
    for repository in repositories:
        repo_name = repository.get("full_name")
        if not repo_name:
            continue

        commits = await github_request(f"/repos/{repo_name}/commits?per_page={per_repo}")
        results.append({
            "repo": repo_name,
            "commits": [format_commit_item(commit) for commit in commits]
        })

    return {
        "status": "ok",
        "count": len(results),
        "items": results
    }


async def ensure_github_token() -> None:
    if not GITHUB_TOKEN:
        raise HTTPException(status_code=401, detail="GITHUB_TOKEN is not configured")


async def github_search(path: str) -> dict:
    payload = await github_request(path)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="GitHub search returned an unexpected response")
    return payload


async def github_request(path: str):
    url = f"{GITHUB_API_BASE_URL}{path}"

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {GITHUB_TOKEN}",
                "User-Agent": "NekoDesk-FastAPI",
            },
        )

    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="GitHub token is invalid or expired")

    if response.status_code == 403:
        raise HTTPException(status_code=403, detail="GitHub API access forbidden")

    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"GitHub API returned HTTP {response.status_code}")

    return response.json()


def format_issue_like_item(item: dict) -> dict:
    return {
        "id": item.get("id"),
        "number": item.get("number"),
        "title": item.get("title"),
        "repo": extract_repo_name(item.get("repository_url")),
        "url": item.get("html_url"),
        "updated_at": item.get("updated_at"),
    }


def format_commit_item(item: dict) -> dict:
    commit = item.get("commit", {}) or {}
    author = commit.get("author", {}) or {}
    return {
        "sha": item.get("sha"),
        "message": first_line(commit.get("message")),
        "author": author.get("name"),
        "date": author.get("date"),
        "url": item.get("html_url"),
    }


def extract_repo_name(repository_url: str | None) -> str | None:
    if not repository_url or "/repos/" not in repository_url:
        return None
    return repository_url.split("/repos/", 1)[1]


def first_line(message: str | None) -> str | None:
    if not message:
        return None
    return message.splitlines()[0].strip() or None
