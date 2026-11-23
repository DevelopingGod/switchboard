"""Helpers for attachment tests: tiny real files built in memory."""

import io

from PIL import Image

from tests.conftest import ADMIN


def png(w: int = 64, h: int = 48, color=(120, 140, 230)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (w, h), color).save(b, "PNG")
    return b.getvalue()


def jpeg_with_exif(w: int = 64, h: int = 32) -> bytes:
    img = Image.new("RGB", (w, h), (10, 200, 10))
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"  # Make
    exif[0x0112] = 6  # orientation: rotate 90
    b = io.BytesIO()
    img.save(b, "JPEG", exif=exif.tobytes())
    return b.getvalue()


def pdf(text: str | None, js: bool = False) -> bytes:
    """A one-page PDF with `text` on it (None = a blank page, like a scan without OCR)."""
    content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode() if text else b""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R"
        + (b" /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>" if js else b"")
        + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


async def upload(client, data: bytes, name: str, expect: int = 200) -> dict:
    from urllib.parse import quote

    r = await client.post(
        "/attachments",
        content=data,
        headers={**ADMIN, "Content-Type": "application/octet-stream", "X-Filename": quote(name)},
    )
    assert r.status_code == expect, r.text
    return r.json()
