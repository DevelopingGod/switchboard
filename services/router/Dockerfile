# syntax=docker/dockerfile:1
FROM python:3.12-slim

# Slow or flaky networks: wait longer for PyPI and retry instead of failing the build (M6.5).
# No PIP_NO_CACHE_DIR: the pip cache lives in a BuildKit cache mount (below), never in the image, so a retried
# build reuses the wheels it already downloaded (M2.5, docs/TROUBLESHOOTING.md).
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/srv/router \
    PIP_DEFAULT_TIMEOUT=120 PIP_RETRIES=10 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv/router

# 1. Dependencies only, in their own layer: it is rebuilt only when pyproject.toml changes, not on code changes.
#    The list is read from pyproject.toml: runtime dependencies, the dev extra (so tests run in this image:
#    docker compose run --rm router pytest) and the build backend (setuptools), so step 2 needs no network.
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -c "import tomllib; t = tomllib.load(open('pyproject.toml', 'rb')); p = t['project']; \
print('\n'.join(p['dependencies'] + p['optional-dependencies']['dev'] + t['build-system']['requires']))" \
       > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && useradd --system --uid 10001 router

# 2. The code. Installing it needs no network: --no-deps, and --no-build-isolation uses the setuptools from step 1.
# The one project version: the repo-root VERSION file, passed as the `root` build context (docker-compose.yml).
COPY --from=root VERSION ./VERSION
COPY app ./app
RUN --mount=type=cache,target=/root/.cache/pip pip install --no-deps --no-build-isolation .
COPY alembic.ini ./
COPY alembic ./alembic
COPY tests ./tests

USER router
EXPOSE 8100
# Migrate, then serve. Bound to 0.0.0.0 inside the container; compose publishes on 127.0.0.1 only.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8100"]
