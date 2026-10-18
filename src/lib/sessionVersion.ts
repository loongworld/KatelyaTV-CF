/* eslint-disable no-console */
import { getD1Database } from './d1.db';

/**
 * 会话版本校验：封禁 / 改密 / 角色变更后，让此前签发的会话立即（≤30 秒）失效。
 *
 * 机制：users 表新增 session_version 列；签发令牌时把版本号写进载荷（sv），
 * API 鉴权层（lib/auth.ts）把 token 里的 sv 与该用户当前版本比对，不一致即视为已吊销。
 * 站长（owner）凭据来自环境变量、不落 users 表，跳过该校验。
 *
 * 校验结果带 30 秒内存缓存（边缘 isolate 级），把每次 API 调用的一次 D1 点查
 * 摊薄到 30 秒最多一次；吊销的最坏生效延迟即 30 秒。
 *
 * 容错策略：
 * - D1 不可用 / 查询异常 → 放行（fail-open）并记日志——此时站点读写本来就在失败，
 *   不应因一次抖动把所有用户踢下线；
 * - 用户不存在（已删除）→ 拒绝，旧会话立即作废；
 * - 库尚未执行 session_version 迁移 → 退回「只判断用户是否存在」，机制静默降级。
 */

const CACHE_TTL_MS = 30_000;

const versionCache = new Map<string, { version: number; ts: number }>();

/** 每次调用时读取（NEXT_PUBLIC_STORAGE_TYPE 构建期会被内联，运行时等价于常量） */
function storageType(): string {
  return process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
}

/** 读取用户当前会话版本；用户不存在返回 null；查询异常抛出。 */
export async function getSessionVersion(username: string): Promise<number | null> {
  const db = getD1Database();
  try {
    const row = await db
      .prepare('SELECT session_version FROM users WHERE username = ?')
      .bind(username)
      .first<{ session_version: number | null }>();
    if (!row) return null;
    return typeof row.session_version === 'number' ? row.session_version : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such column/i.test(message)) {
      // 未执行迁移：退回只判断用户是否存在
      const row = await db
        .prepare('SELECT 1 AS ok FROM users WHERE username = ?')
        .bind(username)
        .first();
      return row ? 0 : null;
    }
    throw err;
  }
}

/**
 * 校验令牌中的会话版本是否仍然有效。
 * 仅用于注册用户（role 为 user / admin）；owner 直接返回 true。
 */
export async function isSessionVersionValid(
  username: string,
  tokenSv: number | undefined
): Promise<boolean> {
  if (storageType() !== 'd1') return true;
  const now = Date.now();
  const cached = versionCache.get(username);
  let current: number | null;
  try {
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      current = cached.version;
    } else {
      current = await getSessionVersion(username);
      if (current === null) {
        versionCache.delete(username);
      } else {
        versionCache.set(username, { version: current, ts: now });
      }
    }
  } catch (err) {
    console.warn('会话版本校验失败（fail-open）:', err);
    return true;
  }
  if (current === null) return false; // 用户已被删除
  return (tokenSv ?? 0) === current;
}

/**
 * 会话版本 +1，吊销该用户名下已签发的全部会话（本 isolate 缓存同步失效，
 * 其他 isolate 最多 30 秒后生效）。失败时仅记日志，不阻断调用方主流程。
 */
export async function bumpSessionVersion(username: string): Promise<void> {
  if (storageType() !== 'd1') return;
  try {
    const db = getD1Database();
    await db
      .prepare(
        'UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE username = ?'
      )
      .bind(username)
      .run();
    versionCache.delete(username);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('吊销会话失败（迁移是否已执行？）:', message);
  }
}
