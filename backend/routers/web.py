from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from scrapling.fetchers import Fetcher

router = APIRouter(prefix="/web", tags=["web"])


class ScrapeResult(BaseModel):
    url: str
    title: str
    content: str


@router.get("/scrape", response_model=ScrapeResult)
def web_scrape(url: str) -> ScrapeResult:
    try:
        Fetcher.configure(auto_match=False)
        page = Fetcher().get(url)

        title_el = page.find("title")
        title = title_el.text.strip() if title_el else ""

        body_el = page.find("body")
        if body_el:
            text = body_el.get_all_text(ignore_tags=("script", "style", "noscript", "nav", "footer"))
        else:
            text = page.get_all_text(ignore_tags=("script", "style", "noscript"))

        return ScrapeResult(url=url, title=title, content=text.strip()[:8000])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
