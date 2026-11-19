"""The low-priority local task queue (M3b, ADR 0002): one background job at a time, never while a
classification is in flight, bounded, and a cancelled waiter gives its place back."""

import asyncio

import pytest

from app import local_queue


@pytest.fixture(autouse=True)
def _fast_poll(monkeypatch):
    monkeypatch.setattr(local_queue, "POLL_S", 0.005)


async def test_jobs_run_one_at_a_time_in_arrival_order():
    order, active, peak = [], 0, 0

    async def job(n):
        nonlocal active, peak
        async with local_queue.background():
            active += 1
            peak = max(peak, active)
            order.append(n)
            await asyncio.sleep(0.01)
            active -= 1

    tasks = []
    for n in range(5):
        tasks.append(asyncio.create_task(job(n)))
        await asyncio.sleep(0)
    await asyncio.gather(*tasks)
    assert order == [0, 1, 2, 3, 4] and peak == 1


async def test_a_job_waits_for_every_classification_in_flight():
    started = asyncio.Event()

    async def job():
        async with local_queue.background():
            started.set()

    async with local_queue.classifying():
        async with local_queue.classifying():
            t = asyncio.create_task(job())
            await asyncio.sleep(0.05)
            assert not started.is_set()
        await asyncio.sleep(0.05)
        assert not started.is_set()  # one classification still open
    await asyncio.wait_for(t, 1)
    assert started.is_set()


async def test_classification_never_waits_for_a_running_job():
    release = asyncio.Event()

    async def job():
        async with local_queue.background():
            await release.wait()

    t = asyncio.create_task(job())
    await asyncio.sleep(0.02)
    assert local_queue.stats()["running"] == 1
    async with asyncio.timeout(0.5), local_queue.classifying():  # enters at once
        pass
    release.set()
    await t


async def test_queue_is_bounded(monkeypatch):
    monkeypatch.setattr(local_queue, "MAX_WAITING", 3)
    release = asyncio.Event()

    async def job():
        async with local_queue.background():
            await release.wait()

    tasks = [asyncio.create_task(job()) for _ in range(4)]  # 1 running + 3 waiting
    await asyncio.sleep(0.03)
    with pytest.raises(local_queue.QueueFull):
        async with local_queue.background():
            pass
    release.set()
    await asyncio.gather(*tasks)
    assert local_queue.stats() == {"classifying": 0, "running": 0, "waiting": 0}


async def test_a_cancelled_waiter_gives_its_place_back():
    release = asyncio.Event()
    ran = []

    async def blocker():
        async with local_queue.background():
            await release.wait()

    async def job(n):
        async with local_queue.background():
            ran.append(n)

    b = asyncio.create_task(blocker())
    await asyncio.sleep(0.02)
    a, c = asyncio.create_task(job("a")), asyncio.create_task(job("c"))
    await asyncio.sleep(0.02)
    a.cancel()  # e.g. its caller timed out
    await asyncio.sleep(0.02)
    release.set()
    await asyncio.gather(b, c)
    assert ran == ["c"] and local_queue.stats()["waiting"] == 0
