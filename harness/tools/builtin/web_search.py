from __future__ import annotations

import html
import json
import os
import re
from typing import Any, Iterable

import httpx

from harness.types.tools import ToolSchema, ToolParam


WEB_SEARCH_SCHEMA = ToolSchema(
    name="web_search",
    description=(
        "Search the public web and return structured search results with title, URL, "
        "snippet, rank, and provider metadata. Provider priority: "
        "1) Dreamatic search module (DREAMATIC_SEARCH_PROVIDER + DREAMATIC_SEARCH_API_KEY), "
        "2) Serper (Google results, requires SERPER_API_KEY), "
        "3) Brave Search (requires BRAVE_SEARCH_API_KEY), "
        "4) DuckDuckGo Instant Answer (free fallback, only answers factual/definition queries)."
    ),
    params=[
        ToolParam(
            name="query",
            type="string",
            description="Search query string. Must be non-empty.",
        ),
        ToolParam(
            name="max_results",
            type="integer",
            description="Maximum number of results to return. Default 5, capped at 10.",
            required=False,
        ),
    ],
)


BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
SERPER_SEARCH_URL = "https://google.serper.dev/search"
DDG_INSTANT_ANSWER_URL = "https://api.duckduckgo.com/"

DEFAULT_SEARCH_RESULTS = 5
MAX_SEARCH_RESULTS = 10

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; AIharness/1.0)",
    "Accept": "application/json",
}


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _clean_text(value: Any) -> str:
    if value is None:
        return ""

    if not isinstance(value, str):
        value = str(value)

    value = html.unescape(value)
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"\s+", " ", value)

    return value.strip()


def _coerce_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = default

    return max(min_value, min(value, max_value))


def _make_title(text: str, fallback: str = "Untitled") -> str:
    text = _clean_text(text)

    if not text:
        return fallback

    if " - " in text:
        return text.split(" - ", 1)[0].strip()

    return text[:100].strip()


async def web_search_tool(query: str, max_results: int = DEFAULT_SEARCH_RESULTS) -> str:
    query = (query or "").strip()
    max_results = _coerce_int(
        max_results,
        default=DEFAULT_SEARCH_RESULTS,
        min_value=1,
        max_value=MAX_SEARCH_RESULTS,
    )

    if not query:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "query": query,
                "results": [],
                "error": {
                    "type": "invalid_request",
                    "message": "query must be a non-empty string",
                },
            }
        )

    dreamatic_search_provider = (os.getenv("DREAMATIC_SEARCH_PROVIDER") or "").strip().casefold()
    dreamatic_search_api_key = os.getenv("DREAMATIC_SEARCH_API_KEY") or ""
    brave_api_key = os.getenv("BRAVE_SEARCH_API_KEY")
    serper_api_key = os.getenv("SERPER_API_KEY")

    if dreamatic_search_api_key and dreamatic_search_provider == "serper":
        serper_api_key = dreamatic_search_api_key
    elif dreamatic_search_api_key and dreamatic_search_provider == "brave":
        brave_api_key = dreamatic_search_api_key
    elif dreamatic_search_api_key and not dreamatic_search_provider:
        serper_api_key = dreamatic_search_api_key

    if serper_api_key:
        return await _serper_web_search(
            query=query,
            max_results=max_results,
            api_key=serper_api_key,
        )

    if brave_api_key:
        return await _brave_web_search(
            query=query,
            max_results=max_results,
            api_key=brave_api_key,
        )

    return await _duckduckgo_instant_answer_fallback(
        query=query,
        max_results=max_results,
    )


async def _brave_web_search(query: str, max_results: int, api_key: str) -> str:
    try:
        timeout = httpx.Timeout(20.0, connect=5.0)

        async with httpx.AsyncClient(timeout=timeout, headers=DEFAULT_HEADERS) as client:
            response = await client.get(
                BRAVE_SEARCH_URL,
                params={
                    "q": query,
                    "count": max_results,
                },
                headers={
                    **DEFAULT_HEADERS,
                    "X-Subscription-Token": api_key,
                    "Cache-Control": "no-cache",
                },
            )

            response.raise_for_status()
            data = response.json()

    except httpx.TimeoutException:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "brave_search",
                "query": query,
                "results": [],
                "error": {
                    "type": "timeout",
                    "message": "Brave Search request timed out",
                },
            }
        )

    except httpx.HTTPStatusError as exc:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "brave_search",
                "query": query,
                "results": [],
                "error": {
                    "type": "http_error",
                    "status_code": exc.response.status_code,
                    "message": f"HTTP {exc.response.status_code} from Brave Search",
                },
            }
        )

    except Exception as exc:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "brave_search",
                "query": query,
                "results": [],
                "error": {
                    "type": "unknown_error",
                    "message": str(exc),
                },
            }
        )

    raw_results = data.get("web", {}).get("results", [])

    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for item in raw_results:
        if len(results) >= max_results:
            break

        if not isinstance(item, dict):
            continue

        title = _clean_text(item.get("title"))
        url = _clean_text(item.get("url"))
        snippet = _clean_text(item.get("description"))

        if not title or not url:
            continue

        if url in seen_urls:
            continue

        seen_urls.add(url)

        profile = item.get("profile")
        source = None

        if isinstance(profile, dict):
            source = _clean_text(profile.get("name")) or None

        results.append(
            {
                "rank": len(results) + 1,
                "title": title,
                "url": url,
                "snippet": snippet,
                "source": source,
                "published": _clean_text(item.get("age")) or None,
            }
        )

    return _json(
        {
            "ok": True,
            "tool": "web_search",
            "provider": "brave_search",
            "query": query,
            "results": results,
            "meta": {
                "max_results": max_results,
                "is_full_web_search": True,
            },
        }
    )


def _iter_ddg_related_topics(items: list[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for item in items:
        if not isinstance(item, dict):
            continue

        topics = item.get("Topics")

        if isinstance(topics, list):
            yield from _iter_ddg_related_topics(topics)
        else:
            yield item


async def _serper_web_search(query: str, max_results: int, api_key: str) -> str:
    """
    Serper.dev Google Search API.

    Free tier: 2,500 queries/month. Sign up at https://serper.dev.
    Returns Google organic search results including People Also Ask, knowledge
    graph, and related searches when present.
    """
    try:
        timeout = httpx.Timeout(20.0, connect=5.0)

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                SERPER_SEARCH_URL,
                headers={
                    "X-API-KEY": api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "q": query,
                    "num": max_results,
                },
            )

            response.raise_for_status()
            data = response.json()

    except httpx.TimeoutException:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "serper",
                "query": query,
                "results": [],
                "error": {
                    "type": "timeout",
                    "message": "Serper (Google) search request timed out",
                },
            }
        )
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code if exc.response is not None else 0
        detail = ""
        try:
            detail = (exc.response.text or "")[:200]
        except Exception:
            pass
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "serper",
                "query": query,
                "results": [],
                "error": {
                    "type": "http_error",
                    "message": f"Serper returned HTTP {status}: {detail}",
                },
            }
        )
    except Exception as exc:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "serper",
                "query": query,
                "results": [],
                "error": {
                    "type": "fetch_error",
                    "message": repr(exc),
                },
            }
        )

    # Extract organic results
    raw_results = data.get("organic", []) or []
    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for rank_zero, item in enumerate(raw_results):
        if len(results) >= max_results:
            break
        if not isinstance(item, dict):
            continue
        url = _clean_text(item.get("link"))
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        results.append(
            {
                "rank": len(results) + 1,
                "title": _clean_text(item.get("title")),
                "url": url,
                "snippet": _clean_text(item.get("snippet")),
                "date": _clean_text(item.get("date")),
                "source": "google_serper",
            }
        )

    # Knowledge graph (if Google provides one for the query)
    kg = data.get("knowledgeGraph")
    kg_payload: dict[str, Any] | None = None
    if isinstance(kg, dict):
        kg_payload = {
            "title": _clean_text(kg.get("title")),
            "type": _clean_text(kg.get("type")),
            "description": _clean_text(kg.get("description")),
            "website": _clean_text(kg.get("website")),
        }

    # People Also Ask (often valuable for LLM context)
    paa = data.get("peopleAlsoAsk") or []
    paa_payload: list[dict[str, Any]] = []
    for q in paa[:5]:
        if isinstance(q, dict):
            paa_payload.append(
                {
                    "question": _clean_text(q.get("question")),
                    "snippet": _clean_text(q.get("snippet")),
                    "link": _clean_text(q.get("link")),
                }
            )

    # Related searches
    related = data.get("relatedSearches") or []
    related_payload: list[str] = [
        r for r in (_clean_text(x.get("query")) for x in related if isinstance(x, dict)) if r
    ][:10]

    search_metadata: dict[str, Any] = {}
    sm = data.get("searchMetadata") or {}
    if isinstance(sm, dict):
        search_metadata["total_time_taken"] = sm.get("totalTimeTaken")
        search_metadata["google_domain"] = sm.get("googleDomain")
        search_metadata["credits_used"] = sm.get("credits")

    payload: dict[str, Any] = {
        "ok": True,
        "tool": "web_search",
        "provider": "serper",
        "query": query,
        "results": results,
        "result_count": len(results),
        "is_full_web_search": True,
        "meta": search_metadata or None,
    }
    if kg_payload:
        payload["knowledge_graph"] = kg_payload
    if paa_payload:
        payload["people_also_ask"] = paa_payload
    if related_payload:
        payload["related_searches"] = related_payload

    return _json(payload)


async def _duckduckgo_instant_answer_fallback(query: str, max_results: int) -> str:
    try:
        timeout = httpx.Timeout(20.0, connect=5.0)

        async with httpx.AsyncClient(timeout=timeout, headers=DEFAULT_HEADERS) as client:
            response = await client.get(
                DDG_INSTANT_ANSWER_URL,
                params={
                    "q": query,
                    "format": "json",
                    "no_html": "1",
                    "no_redirect": "1",
                    "skip_disambig": "1",
                },
            )

            response.raise_for_status()
            data = response.json()

    except httpx.TimeoutException:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "duckduckgo_instant_answer_fallback",
                "query": query,
                "results": [],
                "error": {
                    "type": "timeout",
                    "message": "DuckDuckGo Instant Answer request timed out",
                },
            }
        )

    except httpx.HTTPStatusError as exc:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "duckduckgo_instant_answer_fallback",
                "query": query,
                "results": [],
                "error": {
                    "type": "http_error",
                    "status_code": exc.response.status_code,
                    "message": f"HTTP {exc.response.status_code} from DuckDuckGo",
                },
            }
        )

    except Exception as exc:
        return _json(
            {
                "ok": False,
                "tool": "web_search",
                "provider": "duckduckgo_instant_answer_fallback",
                "query": query,
                "results": [],
                "error": {
                    "type": "search_error",
                    "message": str(exc),
                },
            }
        )

    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    def add_result(title: str, url: str, snippet: str, source_type: str) -> None:
        if len(results) >= max_results:
            return

        title = _clean_text(title)
        url = _clean_text(url)
        snippet = _clean_text(snippet)

        if not title or not url:
            return

        if url in seen_urls:
            return

        seen_urls.add(url)

        results.append(
            {
                "rank": len(results) + 1,
                "title": title,
                "url": url,
                "snippet": snippet,
                "source_type": source_type,
            }
        )

    abstract_text = _clean_text(data.get("AbstractText"))
    abstract_url = _clean_text(data.get("AbstractURL"))
    heading = _clean_text(data.get("Heading"))

    if abstract_text and abstract_url:
        add_result(
            title=heading or _make_title(abstract_text, "DuckDuckGo instant answer"),
            url=abstract_url,
            snippet=abstract_text[:500],
            source_type="abstract",
        )

    for item in data.get("Results", []):
        if not isinstance(item, dict):
            continue

        text = _clean_text(item.get("Text"))
        url = _clean_text(item.get("FirstURL"))

        add_result(
            title=_make_title(text),
            url=url,
            snippet=text,
            source_type="result",
        )

    related_topics = data.get("RelatedTopics", [])

    if isinstance(related_topics, list):
        for item in _iter_ddg_related_topics(related_topics):
            text = _clean_text(item.get("Text"))
            url = _clean_text(item.get("FirstURL"))

            add_result(
                title=_make_title(text),
                url=url,
                snippet=text,
                source_type="related_topic",
            )

    return _json(
        {
            "ok": True,
            "tool": "web_search",
            "provider": "duckduckgo_instant_answer_fallback",
            "query": query,
            "results": results,
            "meta": {
                "max_results": max_results,
                "is_full_web_search": False,
                "warning": (
                    "DuckDuckGo Instant Answer is not a full web search API. "
                    "Configure BRAVE_SEARCH_API_KEY for real search results."
                ),
            },
        }
    )
