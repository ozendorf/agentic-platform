-- App DB "app" is created by POSTGRES_DB. Temporal's auto-setup creates its own
-- databases, but we create them up front so permissions are deterministic.
CREATE DATABASE temporal;
CREATE DATABASE temporal_visibility;
