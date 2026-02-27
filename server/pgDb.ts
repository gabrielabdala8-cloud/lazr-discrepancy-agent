import { Pool } from "pg";

let _pool: Pool | null = null;

export function getPgPool(): Pool {
  if (!_pool) {
    const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false;
    _pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432"),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    _pool.on("error", (err) => {
      console.error("[PgPool] Unexpected error:", err.message);
    });
  }
  return _pool;
}

/** Execute a read-only query against AWS RDS */
export async function pgQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}
