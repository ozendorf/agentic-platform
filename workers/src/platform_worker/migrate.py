"""Apply db/migrations/*.sql in order. Tracks applied files in schema_migrations."""
from __future__ import annotations

import psycopg

from .config import DATABASE_URL, REPO_ROOT


def main() -> None:
    migrations = sorted((REPO_ROOT / "db" / "migrations").glob("*.sql"))
    with psycopg.connect(DATABASE_URL, autocommit=True) as c:
        c.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())")
        done = {r[0] for r in c.execute("SELECT name FROM schema_migrations")}
        for m in migrations:
            if m.name in done:
                continue
            with c.transaction():
                c.execute(m.read_text())
                c.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (m.name,))
            print(f"applied {m.name}")
    print("migrations up to date")


if __name__ == "__main__":
    main()
