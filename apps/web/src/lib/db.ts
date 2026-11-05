import "server-only";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgresql://platform:platform@localhost:5432/app";

// One pool per server process (survives HMR in dev).
const g = globalThis as unknown as { __sql?: postgres.Sql };
export const sql: postgres.Sql = g.__sql ?? postgres(url, { max: 10, idle_timeout: 30 });
if (process.env.NODE_ENV !== "production") g.__sql = sql;
