"""Alembic environment: sync psycopg 3 against DATABASE_URL."""

import os

from alembic import context
from sqlalchemy import create_engine

from app.db import async_url
from app.models import Base

target_metadata = Base.metadata


def run_migrations_online() -> None:
    url = context.config.attributes.get("url") or async_url(os.environ["DATABASE_URL"])
    engine = create_engine(url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


run_migrations_online()
