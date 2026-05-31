CREATE EXTENSION IF NOT EXISTS postgis;

-- The MVP uses app-level migrations as the durable schema contract.
-- SQLAlchemy/Alembic can replace this file-based runner later without changing domain behavior.
