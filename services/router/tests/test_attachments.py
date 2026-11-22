"""Attachments (M2.5): sniffing, storage, extraction, serving headers, routing, privacy, deletion, export."""

import io
import json
import uuid
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import select, update

from app import local_profile
from app.attachments import config as att_config
from app.attachments import service as att_service
from app.attachments import store
from app.attachments.extract import process
from app.attachments.sniff import Refused, safe_name, sniff
from app.litellm_admin import LiteLLMAdmin
from app.models import Attachment, ModelCatalog, Request
from app.reconcile import reconcile
from tests.attachments_util import jpeg_with_exif, pdf, png, upload
from tests.conftest import ADMIN
from tests.test_chat import first, names, stack, turn  # noqa: F401  (fixture re-used)

CFG = att_config.load()


# --- sniffing and names ---------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "data,name,kind",
    [
        (png(), "a.png", "image"),
        (b"%PDF-1.4\n...", "doc.pdf", "pdf"),
        (b"hello\nworld", "notes.md", "text"),
        ("naïve — ünïcode".encode(), "u.txt", "text"),
        (b"#!/bin/sh\necho hi", "run.sh", "text"),
        (b"FROM python:3.12", "Dockerfile", "text"),
    ],
)
def test_sniff_accepts(data, name, kind):
    assert sniff(data, name, CFG, complete=True).kind == kind


@pytest.mark.parametrize(
    "data,name,why",
    [
        (b"MZ\x90\x00" + b"\x00" * 60, "photo.png", "Windows program"),
        (b"\x7fELF\x02\x01", "x.txt", "program"),
        (b"PK\x03\x04rest", "report.pdf", "archive"),
        (b"\x1f\x8b\x08\x00", "logs.txt", "compressed"),
        (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "pic.svg", "SVG"),
        (b"<!DOCTYPE html><html><script>alert(1)</script>", "page.txt", "HTML"),
        (b"<html><body>hi</body></html>", "page.html", "HTML"),
        (png(), "photo.pdf", "doesn't match"),
        (b"%PDF-1.4", "doc.png", "doesn't match"),
        (b"\x00\x01\x02binary", "data.txt", "isn't supported"),
        (b"plain text", "notes.exe", "aren't on the list"),
        (b"", "empty.txt", "empty"),
    ],
)
def test_sniff_refuses_by_content_not_name(data, name, why):
    with pytest.raises(Refused, match=why):
        sniff(data, name, CFG, complete=True)


def test_sniff_code_flag():
    assert sniff(b"def f(): pass", "main.py", CFG, complete=True).code
    assert not sniff(b"a,b\n1,2", "t.csv", CFG, complete=True).code


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\me\\Desktop\\report.pdf", "report.pdf"),
        ("..hidden", "hidden"),
        ("a\x00b\x1f.txt", "ab.txt"),
        ("rm -rf $(x);.md", "rm -rf _(x)_.md"),
        ("x" * 300 + ".pdf", "x" * 116 + ".pdf"),
        ("", "file"),
    ],
)
def test_safe_name(raw, expected):
    assert safe_name(raw) == expected


# --- processing -----------------------------------------------------------------------------------------
def test_image_is_reencoded_without_metadata_and_scaled():
    s = sniff(jpeg_with_exif(), "c.jpg", CFG, complete=True)
    p = process(jpeg_with_exif(), s, CFG)
    img = Image.open(io.BytesIO(p.data))
    assert not img.getexif()  # EXIF (camera, GPS) gone
    assert (p.width, p.height) == (32, 64)  # orientation applied before the metadata was dropped
    assert p.thumb and Image.open(io.BytesIO(p.thumb)).format == "WEBP"
    big = png(3000, 1000)
    p2 = process(big, sniff(big, "b.png", CFG, complete=True), CFG)
    assert max(p2.width, p2.height) == CFG.max_image_px


def test_gif_becomes_png():
    b = io.BytesIO()
    Image.new("P", (10, 10)).save(b, "GIF")
    p = process(b.getvalue(), sniff(b.getvalue(), "a.gif", CFG, complete=True), CFG)
    assert p.mime == "image/png" and p.data.startswith(b"\x89PNG")


def test_decompression_bomb_is_refused():
    cfg = replace(CFG, max_image_pixels=1000)
    data = png(100, 100)
    with pytest.raises(Refused, match="too large"):
        process(data, sniff(data, "x.png", cfg, complete=True), cfg)


def test_damaged_image_is_refused():
    data = png()[:40]
    with pytest.raises(Refused, match="couldn't be read"):
        process(data, sniff(data, "x.png", CFG, complete=True), CFG)


def test_pdf_text_scanned_and_secret():
    p = process(pdf("Quarterly report"), sniff(b"%PDF-", "r.pdf", CFG), CFG)
    assert "Quarterly report" in p.text and p.pages == 1 and not p.note
    scanned = process(pdf(None), sniff(b"%PDF-", "s.pdf", CFG), CFG)
    assert scanned.text is None and "scanned PDF" in scanned.note
    key = "sk-proj-" + "A1b2C3d4" * 6  # gitleaks:allow
    secret = process(pdf(f"key {key}"), sniff(b"%PDF-", "k.pdf", CFG), CFG)
    assert key not in secret.text and "[secret masked" in secret.text and secret.secret_kinds


def test_pdf_page_cap():
    cfg = replace(CFG, max_pdf_pages=1)
    from pypdf import PdfReader, PdfWriter

    w = PdfWriter()
    for page in list(PdfReader(io.BytesIO(pdf("one"))).pages) * 3:
        w.add_page(page)
    b = io.BytesIO()
    w.write(b)
    p = process(b.getvalue(), sniff(b"%PDF-", "x.pdf", cfg), cfg)
    assert p.pages == 3 and p.pages_read == 1 and p.truncated


def test_text_cap():
    cfg = replace(CFG, max_text_chars=1000)
    data = b"a" * 5000
    p = process(data, sniff(data, "a.txt", cfg, complete=True), cfg)
    assert len(p.text) == 1000 and p.truncated


# --- upload, serve, delete --------------------------------------------------------------------------------
async def test_upload_needs_admin(client):
    r = await client.post("/attachments", content=b"x", headers={"X-Filename": "a.txt"})
    assert r.status_code == 401


async def test_upload_stages_files_with_private_permissions(client, data_dir, session):
    a = await upload(client, png(), "shot.png")
    assert a["kind"] == "image" and a["width"] == 64 and a["status"] == "staged" and a["tokens"] > 0
    row = await session.get(Attachment, uuid.UUID(a["id"]))
    folder = data_dir / "attachments" / "staging" / a["id"]
    assert (folder / row.sha256).exists() and (folder / f"{row.sha256}.thumb.webp").exists()
    assert oct(folder.stat().st_mode & 0o777) == "0o700"
    assert oct((folder / row.sha256).stat().st_mode & 0o777) == "0o600"


async def test_upload_refusals_are_plain(client):
    r = await upload(client, b"MZ\x90\x00" * 20, "cat.png", expect=415)
    assert "Windows program" in r["detail"]
    big = b"a" * (CFG.max_file_bytes + 1)
    r = await upload(client, big, "big.txt", expect=413)
    assert "MB limit" in r["detail"]


async def test_image_served_inline_with_strict_headers(client):
    a = await upload(client, png(), "shot.png")
    r = await client.get(f"/attachments/{a['id']}", headers=ADMIN)
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'none'" in r.headers["content-security-policy"]
    assert "sandbox" in r.headers["content-security-policy"]
    assert r.headers["content-disposition"].startswith("inline")
    t = await client.get(f"/attachments/{a['id']}/thumb", headers=ADMIN)
    assert t.status_code == 200 and t.headers["content-type"] == "image/webp"


@pytest.mark.parametrize(
    "data,name", [(pdf("hi", js=True), "with-js.pdf"), (b"<b>not html</b> text", "a.md")]
)
async def test_documents_are_only_ever_downloads(client, data, name):
    """A PDF (even one with JavaScript) or a text file that looks like markup is never rendered on the portal
    origin: it is served as an opaque download."""
    a = await upload(client, data, name)
    r = await client.get(f"/attachments/{a['id']}", headers=ADMIN)
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]
    assert (await client.get(f"/attachments/{a['id']}/thumb", headers=ADMIN)).status_code == 404


async def test_delete_staged_is_idempotent(client, data_dir):
    a = await upload(client, b"hello", "a.txt")
    for _ in range(2):
        r = await client.delete(f"/attachments/{a['id']}", headers=ADMIN)
        assert r.status_code == 200
    assert not (data_dir / "attachments" / "staging" / a["id"]).exists()


def test_sweep_removes_old_uploads(data_dir):
    d = store.staging_dir(uuid.uuid4())
    store.write(d / ("a" * 64), b"x")
    assert store.sweep_staging(24, now=__import__("time").time() + 25 * 3600) == 1
    assert not d.exists()


def test_remove_dir_refuses_outside_root(tmp_path):
    with pytest.raises(ValueError):
        store.remove_dir(tmp_path / "elsewhere")


# --- chat ---------------------------------------------------------------------------------------------------
@pytest.fixture
async def vision(stack, session):
    """Gemini's smart-free model can read images and has a long context; Groq can't read images."""
    await session.execute(
        update(ModelCatalog)
        .where(ModelCatalog.provider == "gemini")
        .values(tags_json=["chat", "fast", "vision", "long-context"], context=1_000_000)
    )
    await session.execute(update(ModelCatalog).where(ModelCatalog.provider == "groq").values(context=131_072))
    await session.commit()
    return stack


def wire(litellm, i=-1):
    return litellm.stream_calls[i]["messages"]


async def test_image_needs_a_vision_model(client, vision, session, data_dir):
    a = await upload(client, png(), "chart.png")
    ev = await turn(client, text="What does this chart show?", attachment_ids=[a["id"]])
    done = first(ev, "done")
    chip = done["route"]
    assert chip["rule"] == "vision" and chip["provider"] == "gemini"
    assert chip["reasons"][0].startswith("Needs vision")
    assert chip["attachments"]["vision"] is True
    last = wire(vision)[-1]
    assert isinstance(last["content"], list)
    assert last["content"][0] == {"type": "text", "text": "What does this chart show?"}
    assert last["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    # bound to the message, moved into the thread's folder
    start = first(ev, "start")
    assert start["user_attachments"][0]["name"] == "chart.png"
    row = await session.get(Attachment, uuid.UUID(a["id"]))
    await session.refresh(row)
    assert row.status == "bound" and row.message_id == start["user_message_id"]
    assert (data_dir / "attachments" / "threads" / str(start["thread_id"]) / row.sha256).exists()
    assert not (data_dir / "attachments" / "staging" / a["id"]).exists()
    # the thread shows it
    t = (await client.get(f"/chat/threads/{start['thread_id']}", headers=ADMIN)).json()
    assert t["messages"][0]["attachments"][0]["kind"] == "image"


async def test_manual_pick_without_vision_falls_to_a_vision_model(client, vision):
    a = await upload(client, png(), "chart.png")
    ev = await turn(client, text="describe", target="model:fast", attachment_ids=[a["id"]])
    chip = first(ev, "done")["route"]
    assert chip["provider"] == "gemini"
    assert any(s["code"] == "needs_vision" and s["target"] == "model:fast" for s in chip["skipped"])


async def test_no_vision_model_connected_gives_a_clear_error(client, stack):
    a = await upload(client, png(), "chart.png")
    ev = await turn(client, text="describe", attachment_ids=[a["id"]])
    err = first(ev, "error")
    assert err["code"] == "no_vision" and "read images" in err["message"]
    assert stack.stream_calls == []


async def test_private_image_never_leaves_the_machine(client, vision):
    """No local vision model: a clear message, and not one call to anything."""
    a = await upload(client, png(), "scan.png")
    ev = await turn(client, text="read this", private=True, attachment_ids=[a["id"]])
    err = first(ev, "error")
    assert err["code"] == "no_local_vision" and "never sent to the cloud" in err["message"]
    assert vision.stream_calls == []


async def test_private_image_uses_the_local_vision_model(client, vision, session, monkeypatch):
    prof = local_profile.active()
    monkeypatch.setattr(local_profile, "active", lambda: replace(prof, vision="qwen2.5vl:3b"))
    session.add(
        ModelCatalog(
            provider="ollama",
            model_id="qwen2.5vl:3b",
            tags_json=["chat", "vision"],
            prices_json={},
            privacy="local",
            tag_source="curated",
            free=True,
            meta_json={},
        )
    )
    await session.commit()
    admin = LiteLLMAdmin()
    await reconcile(session, admin)
    await admin.aclose()
    a = await upload(client, png(), "scan.png")
    ev = await turn(client, text="read this", private=True, attachment_ids=[a["id"]])
    assert first(ev, "route")["target"] == "model:local-vision"
    assert first(ev, "route")["local"] is True
    assert all(c["model"] == "local-vision" for c in vision.stream_calls)


async def test_secret_in_a_file_keeps_the_turn_local_and_masked(client, vision, session):
    key = "sk-proj-" + "Z9y8X7w6" * 6  # gitleaks:allow
    a = await upload(client, f"config:\n  api_key: {key}\n".encode(), "settings.yaml")
    assert a["secret"]
    ev = await turn(client, text="what is wrong here?", attachment_ids=[a["id"]])
    start = first(ev, "start")
    assert start["private"] is True
    assert {c["model"] for c in vision.stream_calls} <= {"local", "private", "local-code", "local-think"}
    sent = json.dumps(vision.stream_calls)
    assert key not in sent and "[secret masked" in sent
    req = await session.get(Request, start["request_id"])
    assert req.private and key not in json.dumps(req.decision_json)


async def test_long_document_prefers_long_context(client, vision, monkeypatch):
    monkeypatch.setattr(att_config, "load", lambda *_: replace(CFG, long_document_tokens=50))
    a = await upload(client, ("The quarterly numbers grew. " * 40).encode(), "report.txt")
    ev = await turn(client, text="summarize", attachment_ids=[a["id"]])
    chip = first(ev, "done")["route"]
    assert chip["rule"] == "long-document" and chip["provider"] == "gemini"
    assert chip["reasons"][0].startswith("Long document")
    content = wire(vision)[-1]["content"]
    assert isinstance(content, str) and "[Attached file “report.txt”]" in content and "quarterly" in content


async def test_code_file_uses_the_code_rule(client, vision):
    a = await upload(client, b"def add(a, b):\n    return a - b\n", "calc.py")
    ev = await turn(client, text="why is this wrong?", attachment_ids=[a["id"]])
    chip = first(ev, "done")["route"]
    assert chip["rule"] == "code-light" and chip["intent"] == "code"
    assert "```py" in wire(vision)[-1]["content"]


async def test_scanned_pdf_is_noted(client, vision):
    a = await upload(client, pdf(None), "scan.pdf")
    assert "scanned PDF" in a["note"]
    await turn(client, text="what does it say?", attachment_ids=[a["id"]])
    assert "scanned PDF" in wire(vision)[-1]["content"]


async def test_attachment_only_message_and_limits(client, vision):
    a = await upload(client, b"just a note", "n.txt")
    ev = await turn(client, text="", attachment_ids=[a["id"]])
    assert first(ev, "start")["title"] == "n.txt"
    r = await client.post("/chat/send", json={"text": ""}, headers=ADMIN)
    assert r.status_code == 422
    # a file can only be sent once
    r = await client.post("/chat/send", json={"text": "again", "attachment_ids": [a["id"]]}, headers=ADMIN)
    assert r.status_code == 409
    many = [
        (await upload(client, f"{i}".encode(), f"{i}.txt"))["id"]
        for i in range(CFG.max_files_per_message + 1)
    ]
    r = await client.post("/chat/send", json={"text": "x", "attachment_ids": many}, headers=ADMIN)
    assert r.status_code == 422


async def test_older_images_become_notes(client, vision):
    a = await upload(client, png(), "one.png")
    ev = await turn(client, text="first", attachment_ids=[a["id"]])
    tid = first(ev, "start")["thread_id"]
    await turn(client, text="follow-up", thread_id=tid)
    hist = wire(vision)
    assert isinstance(hist[1]["content"], list)  # still the newest image turn: image resent
    b = await upload(client, png(color=(1, 2, 3)), "two.png")
    await turn(client, text="and this one?", thread_id=tid, attachment_ids=[b["id"]])
    hist = wire(vision)
    first_user = next(m for m in hist if m["role"] == "user")
    assert (
        isinstance(first_user["content"], str)
        and "[Image “one.png” attached earlier]" in first_user["content"]
    )
    assert isinstance(hist[-1]["content"], list)


async def test_estimate_before_sending(client, vision):
    a = await upload(client, png(1000, 800), "shot.png")
    r = await client.post("/chat/estimate", json={"text": "hi", "attachment_ids": [a["id"]]}, headers=ADMIN)
    e = r.json()
    assert e["provider"] == "gemini" and e["documented"] is True and e["needs_vision"]
    assert e["attachment_tokens"] == 258 * 4  # Gemini: 768 px tiles, 258 tokens each; 1000x800 is 2x2 tiles


async def test_quota_guard_counts_attachment_tokens(client, vision, monkeypatch):
    """~50k tokens of document can't fit Groq's free 8k tokens-per-minute window: skipped before the call."""
    monkeypatch.setattr(att_config, "load", lambda *_: replace(CFG, long_document_tokens=10**9))
    a = await upload(client, ("word " * 50_000)[: CFG.max_text_chars].encode(), "big.txt")
    ev = await turn(client, text="summarize", attachment_ids=[a["id"]])
    chip = first(ev, "done")["route"]
    skip = next(s for s in chip["skipped"] if s["target"] == "model:fast")
    assert skip["code"] == "quota" and "with attachments" in skip["reason"]
    assert chip["provider"] == "gemini"
    assert all(c["model"] != "fast" for c in vision.stream_calls)


# --- deletion and export ------------------------------------------------------------------------------------
async def test_files_go_with_their_chat(client, vision, data_dir, session):
    a = await upload(client, png(), "x.png")
    ev = await turn(client, text="hi", attachment_ids=[a["id"]])
    tid = first(ev, "start")["thread_id"]
    folder = data_dir / "attachments" / "threads" / str(tid)
    assert folder.exists()
    assert (await client.delete(f"/chat/threads/{tid}", headers=ADMIN)).status_code == 200
    assert not folder.exists()
    assert (await session.execute(select(Attachment))).first() is None
    b = await upload(client, png(), "y.png")
    ev = await turn(client, text="hi", attachment_ids=[b["id"]])
    r = await client.request("DELETE", "/chat/threads", json={"confirm": "delete all chats"}, headers=ADMIN)
    assert r.status_code == 200 and not (data_dir / "attachments" / "threads").exists()


async def test_same_file_twice_in_a_thread_is_stored_once(client, vision, data_dir):
    a = await upload(client, png(), "x.png")
    ev = await turn(client, text="one", attachment_ids=[a["id"]])
    tid = first(ev, "start")["thread_id"]
    b = await upload(client, png(), "x-again.png")
    await turn(client, text="two", thread_id=tid, attachment_ids=[b["id"]])
    files = [p for p in (data_dir / "attachments" / "threads" / str(tid)).iterdir() if "." not in p.name]
    assert len(files) == 1


async def test_export_lists_attachments_and_zips_them_only_when_asked(client, vision):
    a = await upload(client, b"hello file", "note.txt")
    await turn(client, text="hi", attachment_ids=[a["id"]])
    r = await client.get("/chat/export", headers=ADMIN)
    data = r.json()
    att = data["threads"][0]["messages"][0]["attachments"][0]
    assert att["name"] == "note.txt" and "hello file" not in r.text
    r = await client.get("/chat/export?include_attachments=true", headers=ADMIN)
    assert r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names_ = z.namelist()
    assert "switchboard-chats.json" in names_
    assert any(n.endswith("/note.txt") for n in names_)
    md = await client.get("/chat/export?format=md", headers=ADMIN)
    assert "_Attached: note.txt" in md.text


def test_paths_reject_bad_hashes():
    with pytest.raises(ValueError):
        store.path(Path("/x"), "../../etc/passwd")


def test_to_wire_drops_private_keys():
    msgs = [{"role": "user", "content": "x", "_mid": 1, "_extra": 5}, {"role": "assistant", "content": "y"}]
    out = att_service.to_wire(msgs, {}, 1)
    assert out == [{"role": "user", "content": "x"}, {"role": "assistant", "content": "y"}]
