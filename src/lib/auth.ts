import { getSessionFromRequest, USER_COOKIE } from './session';
import { isSessionVersionValid } from './sessionVersion';

/**
 * 服务端：从签名 Cookie 取得当前用户。未登录或签名无效返回 null。
 * 所有需要身份的接口都只能通过它获取用户名，不得读取请求体或请求头里的用户名。
 * 对注册用户（非站长）额外校验会话版本：被封禁 / 改密 / 角色变更后，
 * 旧会话最多 30 秒内失效（见 lib/sessionVersion.ts）。
 */
export async function getAuthInfoFromCookie(
  request: Request
): Promise<{ username: string; role: 'owner' | 'admin' | 'user' } | null> {
  const session = await getSessionFromRequest(request);
  if (!session) return null;
  if (session.role !== 'owner') {
    const valid = await isSessionVersionValid(session.username, session.sv);
    if (!valid) return null;
  }
  return session;
}

/**
 * 客户端：读取 kt_user 显示用 Cookie（不含签名，仅用于界面展示，不参与鉴权）。
 */
export function getAuthInfoFromBrowserCookie(): {
  username?: string;
  role?: 'owner' | 'admin' | 'user';
} | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const entry = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${USER_COOKIE}=`));
    if (!entry) return null;
    const raw = decodeURIComponent(entry.slice(USER_COOKIE.length + 1));
    const data = JSON.parse(raw);
    if (!data || typeof data.username !== 'string') return null;
    return { username: data.username, role: data.role };
  } catch {
    return null;
  }
}
