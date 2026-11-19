"""Sidebar recents (M3b): keyset pagination on (updated_at, id), pinned listed apart, title search."""

from datetime import UTC, datetime, timedelta

from app.models import Thread
from tests.conftest import ADMIN

T0 = datetime(2026, 11, 19, 12, 0, tzinfo=UTC)


async def seed(session, titles, pinned=(), same_time=()):
    """Titles oldest -> newest; `same_time` titles share one timestamp (a keyset tie)."""
    for i, title in enumerate(titles):
        at = T0 + timedelta(minutes=0 if title in same_time else i)
        session.add(Thread(title=title, updated_at=at, created_at=at, pinned=title in pinned))
    await session.commit()


async def page(client, **params):
    r = await client.get("/chat/threads", params=params, headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


async def test_pages_cover_every_unpinned_thread_once_newest_first(client, session):
    await seed(session, [f"chat {i}" for i in range(10)], pinned=("chat 2",))
    seen, cursor, pages = [], None, 0
    while True:
        d = await page(client, limit=4, **({"cursor": cursor} if cursor else {}))
        pages += 1
        if pages == 1:
            assert [t["title"] for t in d["pinned"]] == ["chat 2"]
        else:
            assert d["pinned"] == []  # pinned only on the first page
        seen += [t["title"] for t in d["threads"]]
        cursor = d["next_cursor"]
        if not cursor:
            break
    assert pages == 3
    assert seen == [f"chat {i}" for i in (9, 8, 7, 6, 5, 4, 3, 1, 0)]  # no duplicates, none missing


async def test_threads_with_the_same_timestamp_are_not_skipped_or_repeated(client, session):
    names = [f"tie {i}" for i in range(7)]
    await seed(session, names, same_time=set(names))
    seen, cursor = [], None
    for _ in range(10):
        d = await page(client, limit=2, **({"cursor": cursor} if cursor else {}))
        seen += [t["id"] for t in d["threads"]]
        cursor = d["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 7 and len(set(seen)) == 7


async def test_search_matches_titles_anywhere_including_pinned_and_paginates(client, session):
    await seed(
        session,
        ["Trip to Japan", "japanese grammar", "Tax return", "100% sure", "a_b literal", "axb"],
        pinned=("Trip to Japan",),
    )
    d = await page(client, q="JAPAN")
    assert d["pinned"] == [] and {t["title"] for t in d["threads"]} == {"Trip to Japan", "japanese grammar"}
    assert [t["title"] for t in (await page(client, q="100%"))["threads"]] == ["100% sure"]  # % is literal
    assert [t["title"] for t in (await page(client, q="a_b"))["threads"]] == ["a_b literal"]  # _ is literal
    assert (await page(client, q="nothing like this"))["threads"] == []
    d = await page(client, q="a", limit=2)
    assert len(d["threads"]) == 2 and d["next_cursor"]
    d2 = await page(client, q="a", limit=2, cursor=d["next_cursor"])
    assert not {t["id"] for t in d["threads"]} & {t["id"] for t in d2["threads"]}


async def test_bad_input_is_refused(client):
    for params in ({"cursor": "garbage"}, {"cursor": "2026-11-19T12:00:00+00:00_not-a-uuid"}):
        r = await client.get("/chat/threads", params=params, headers=ADMIN)
        assert r.status_code == 400
    for params in ({"limit": 0}, {"limit": 101}, {"q": "x" * 81}):
        assert (await client.get("/chat/threads", params=params, headers=ADMIN)).status_code == 422
    assert (await client.get("/chat/threads")).status_code == 401
