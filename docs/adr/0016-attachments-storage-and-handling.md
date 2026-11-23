# 0016. Attachments: a host data folder, bytes decide the type, per-thread copies, never committed

Status: accepted (2026-11-22, M2.5)

## Context
M2.5 adds files and images to chat and to agent jobs. They are personal data, they must survive restarts, they
are deleted with their chat, and a job's agent must be able to read them inside its git worktree (which lives on
the host and is created by hostprobe, ADR 0008). The router runs in Docker; hostprobe runs as the owner on the
host. Anything the portal shows comes from its own origin, so a file must never be able to run there.

## Options
**Where the bytes live**
1. **A host folder bind-mounted into the router** (`~/.switchboard/data`, `SWITCHBOARD_DATA_DIR`): hostprobe reads
   the same folder to copy files into a worktree; survives `docker compose down -v`.
2. A named Docker volume: hostprobe can't see it, so the router would send every job file to hostprobe over HTTP.
3. Postgres (`bytea`): no folder to manage, but backups and the database grow with every screenshot.

**Who can read it.** The router image runs as uid 10001, hostprobe as the owner. A shared group would need the
folder at 0770; running the router container as the owner's uid/gid keeps it at **0700**.

**What a file is.** Extension, the browser's MIME type, `python-magic` (libmagic, a system library) or our own
signature check for a short allowlist.

## Decision
- **Option 1**, mode 0700, owned by the owner; the router container runs as `SWITCHBOARD_UID:SWITCHBOARD_GID`
  (written by `setup-wsl.sh`, checked by `doctor.sh`). Never inside the repository (setup refuses; hostprobe
  refuses to copy from a data folder inside a repo).
- Layout: `attachments/staging/<upload id>/` (uploaded, not sent; swept after `staging_ttl_h`),
  `attachments/threads/<thread id>/<sha256>` (one copy per content hash per chat) and
  `attachments/jobs/<job id>/<sha256>`. Deleting a chat deletes its folder; "already gone" counts as deleted.
- **Bytes decide the type** (own signatures: PNG, JPEG, WebP, GIF, PDF; UTF-8 text without NUL bytes) and the
  extension must agree. Archives, programs, HTML and SVG are refused with a plain reason. Images are decoded under
  a pixel cap (decompression bombs), re-encoded without metadata (EXIF, GPS) and scaled to `max_image_px`; GIFs
  become PNG. PDFs give text (pypdf, page cap; "scanned PDF" when there is none). Extracted text is secret-scanned
  and stored masked; a secret keeps the turn local. Nothing is executed. Limits live in `config/attachments.yaml`.
- **Serving:** only raster images inline, with `Content-Security-Policy: default-src 'none'; …; sandbox` and
  `nosniff`; PDFs and text are always `application/octet-stream` downloads. The portal re-applies these headers,
  whatever the router sent.
- **Jobs:** the job gets its own copy (`jobs/<id>/`); hostprobe copies it into `<worktree>/.switchboard/attachments/`
  with a `.switchboard/.gitignore` of `*`, and the commit and diff exclude `.switchboard` by pathspec as well, so
  the files are never committed even if the ignore file is removed. Removing the worktree removes the job copy.
- Uploads are a raw body with the name in a header (no multipart parser). Pillow and pypdf are pinned.

## Consequences
- One more folder to back up (TROUBLESHOOTING "Data folder"); exports include files only when asked (.zip).
- If Docker starts the router before setup created the folder, Docker creates it as root; doctor says so and the
  fix needs the owner's own `sudo chown` once (Switchboard never runs sudo).
- A chat file carried into a job is copied, so deleting the chat doesn't break a running job.
- OCR, audio/video files and Office documents are not accepted yet (carry-overs).
