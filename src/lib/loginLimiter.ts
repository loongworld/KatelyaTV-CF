/* 登录失败限速：基于 D1 的固定窗口计数，按 IP 与用户名分别计数。 */

interface Db {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
  exec?(sql: string): Promise<unknown>;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

let tableReady = false;

async function ensureTable(db: Db): Promise<void> {
  if (tableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS login_attempts (
        scope_key TEXT PRIMARY KEY,
        fail_count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0
      )`
    )
    .bind()
    .run();
  tableReady = true;
}

/** 返回剩余锁定秒数；0 表示允许尝试。db 为空时不限速（仅用于无 D1 的本地模式）。 */
export async function getLoginLockSeconds(
  db: Db | null,
  keys: string[]
): Promise<number> {
  if (!db) return 0;
  await ensureTable(db);
  const now = Date.now();
  let maxRemaining = 0;
  for (const key of keys) {
    const row = await db
      .prepare('SELECT locked_until FROM login_attempts WHERE scope_key = ?')
      .bind(key)
      .first<{ locked_until: number }>();
    if (row && row.locked_until > now) {
      maxRemaining = Math.max(maxRemaining, Math.ceil((row.locked_until - now) / 1000));
    }
  }
  return maxRemaining;
}

/**
 * 记录一次失败。整段「读取旧计数 → 判断窗口 → 累加 → 写回」压进单条 UPSERT，
 * 由 SQLite 串行化。原先的读-改-写实现里，两个并发请求会读到同一个 fail_count
 * 再各自写回同一个值，5 次锁定的阈值因此被稀释。
 */
export async function recordLoginFailure(db: Db | null, keys: string[]): Promise<void> {
  if (!db) return;
  await ensureTable(db);
  const now = Date.now();
  for (const key of keys) {
    await db
      .prepare(
        `INSERT INTO login_attempts (scope_key, fail_count, window_start, locked_until)
         VALUES (?, 1, ?, 0)
         ON CONFLICT(scope_key) DO UPDATE SET
           fail_count = CASE
             WHEN ? - login_attempts.window_start < ? THEN login_attempts.fail_count + 1
             ELSE 1
           END,
           window_start = CASE
             WHEN ? - login_attempts.window_start < ? THEN login_attempts.window_start
             ELSE ?
           END,
           locked_until = CASE
             WHEN (
               CASE
                 WHEN ? - login_attempts.window_start < ? THEN login_attempts.fail_count + 1
                 ELSE 1
               END
             ) >= ? THEN ? + ?
             ELSE 0
           END`
      )
      .bind(
        key,
        now,
        now,
        WINDOW_MS,
        now,
        WINDOW_MS,
        now,
        now,
        WINDOW_MS,
        MAX_FAILURES,
        now,
        LOCK_MS
      )
      .run();
  }
}

export async function clearLoginFailures(db: Db | null, keys: string[]): Promise<void> {
  if (!db) return;
  await ensureTable(db);
  for (const key of keys) {
    await db
      .prepare('DELETE FROM login_attempts WHERE scope_key = ?')
      .bind(key)
      .run();
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}
