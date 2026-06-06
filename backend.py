"""
Lightweight backend for Render — serves Firebase config and crypto news.
Requires: fastapi uvicorn httpx
"""

import os
import time
import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://hammadrehmanawan.github.io",
        "https://hammadrehman-crypto-futures-calculator.hf.space",
    ],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


# In-memory news cache — avoids hammering upstream APIs on every page load
_news_cache: dict = {"items": None, "ts": 0.0}
_NEWS_TTL = 300  # 5 minutes


@app.get("/news")
async def get_news():
    global _news_cache
    now = time.time()
    if _news_cache["items"] is not None and now - _news_cache["ts"] < _NEWS_TTL:
        return _news_cache["items"]

    items: list = []

    # ── Source 1: CryptoCompare (server-to-server, no API key needed) ──
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(
                "https://min-api.cryptocompare.com/data/v2/news/",
                params={
                    "lang": "EN",
                    "sortOrder": "latest",
                    "limit": "30",
                    "categories": "BTC,ETH,SOL,XRP,BNB,Crypto,Regulation,Mining,Technology",
                },
                headers={"User-Agent": "FutureX/1.0"},
            )
            if r.status_code == 200:
                raw = r.json().get("Data", [])
                if isinstance(raw, list):
                    items = [
                        {
                            "title":        a["title"],
                            "url":          a.get("url", ""),
                            "source":       a.get("source", ""),
                            "published_on": a["published_on"],
                        }
                        for a in raw
                        if a.get("title") and a.get("published_on")
                    ]
    except Exception:
        pass

    # ── Source 2: Hacker News Algolia (fallback) ──
    if not items:
        try:
            cutoff = int(now) - 7 * 24 * 3600  # 7 days for HN (it's broader)
            async with httpx.AsyncClient(timeout=12.0) as client:
                r = await client.get(
                    "https://hn.algolia.com/api/v1/search_by_date",
                    params={
                        "query": "bitcoin ethereum crypto blockchain solana regulation XRP",
                        "tags": "story",
                        "hitsPerPage": "20",
                        "numericFilters": f"created_at_i>{cutoff}",
                    },
                )
                if r.status_code == 200:
                    hits = r.json().get("hits", [])
                    items = [
                        {
                            "title":        h["title"],
                            "url":          h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}",
                            "source":       (h["url"].split("/")[2].replace("www.", "") if h.get("url") else "Hacker News"),
                            "published_on": h["created_at_i"],
                        }
                        for h in hits
                        if h.get("title") and h.get("created_at_i")
                    ]
        except Exception:
            pass

    if items:
        _news_cache = {"items": items, "ts": now}

    return _news_cache["items"] or []


@app.get("/firebase-config")
def firebase_config():
    return JSONResponse({
        "apiKey":            os.environ.get("FIREBASE_API_KEY", ""),
        "authDomain":        os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
        "projectId":         os.environ.get("FIREBASE_PROJECT_ID", ""),
        "storageBucket":     os.environ.get("FIREBASE_STORAGE_BUCKET", ""),
        "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId":             os.environ.get("FIREBASE_APP_ID", ""),
        "measurementId":     os.environ.get("FIREBASE_MEASUREMENT_ID", ""),
    })


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
