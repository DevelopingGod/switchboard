FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PYTHONPATH=/srv/router
WORKDIR /srv/router

COPY pyproject.toml ./
COPY app ./app
# Dev extras are included so tests run in the same image: docker compose run --rm router pytest
RUN pip install ".[dev]" && useradd --system --uid 10001 router
COPY alembic.ini ./
COPY alembic ./alembic
COPY tests ./tests

USER router
EXPOSE 8100
# Migrate, then serve. Bound to 0.0.0.0 inside the container; compose publishes on 127.0.0.1 only.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8100"]
