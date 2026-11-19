"""The one project version (repo-root VERSION file; scripts/check-docs.mjs keeps every copy equal)."""

from pathlib import Path

_HERE = Path(__file__).resolve()


def read_version() -> str:
    # Docker image: /srv/router/VERSION (copied from the repo root at build). Checkout: the repo root.
    for base in _HERE.parents[1:4]:
        p = base / "VERSION"
        if p.is_file():
            return p.read_text().strip()
    return "0.0.0+unknown"


VERSION = read_version()
