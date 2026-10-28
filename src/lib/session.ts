import { base64UrlToBytes, bytesToBase64Url, bytesToHex } from './secure';

/**
 * 会话令牌：base64url(JSON载荷) + '.' + base64url(HMAC-SHA256(载荷))。
 * 服务端只信任签名通过的 Cookie；前端显示用的 kt_user 不参与鉴权。
 */
export const AUTH_COOKIE = 'auth';
export const USER_COOKIE = 'kt_user';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_VERSION = 2;

export type Role = 'owner' | 'admin' | 'user';
export interface Session {
  username: string;
  role: Role;
  /**
   * 会话版本号（脱库校验用）。签发时从 users 表读取；服务端比对不一致即视为已吊销。
   * 不做全站逐请求校验，只在 API 鉴权层（lib/auth）做带缓存的比对，见 lib/sessionVersion.ts。
   */
  sv?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 签名密钥材料：优先 SESSION_SECRET（≥32 字符），否则由 AUTH_PASSWORD 派生。
 * 两者都没有时返回 null，所有签名与校验都失败（fail closed）。
 */
export function getSessionMaterial(): string | null {
  const explicit = process.env.SESSION_SECRET;
  if (explicit && explicit.length >= 32) return `session:${explicit}`;
  const pwd = process.env.AUTH_PASSWORD;
  if (pwd) return `derived:${pwd}`;
  return null;
}

let keyCache: { material: string; key: CryptoKey } | null = null;

async function getHmacKey(): Promise<CryptoKey | null> {
  const material = getSessionMaterial();
  if (!material) return null;
  if (keyCache && keyCache.material === material) return keyCache.key;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  keyCache = { material, key };
  return key;
}

export async function createSessionValue(session: Session): Promise<string | null> {
  const key = await getHmacKey();
  if (!key) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: TOKEN_VERSION,
    u: session.username,
    r: session.role,
    sv: session.sv ?? 0,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(mac))}`;
}

export async function verifySessionValue(value: string): Promise<Session | null> {
  const key = await getHmacKey();
  if (!key) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  let macBytes: Uint8Array;
  let payload: Record<string, unknown>;
  try {
    macBytes = base64UrlToBytes(mac);
    payload = JSON.parse(decoder.decode(base64UrlToBytes(body)));
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify('HMAC', key, macBytes, encoder.encode(body));
  if (!valid) return null;
  if (payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 < Date.now()) return null;
  const role: Role = payload.r === 'owner' || payload.r === 'admin' ? payload.r : 'user';
  // 早期令牌没有 sv 字段，按 0 处理：只要用户从未触发过吊销（版本仍为 0）就继续有效
  const sv =
    typeof payload.sv === 'number' && Number.isFinite(payload.sv) ? payload.sv : 0;
  return { username: payload.u, role, sv };
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

export async function getSessionFromRequest(request: Request): Promise<Session | null> {
  const raw = readCookie(request, AUTH_COOKIE);
  if (!raw) return null;
  return verifySessionValue(raw);
}

/** 站点 Cookie 属性：仅 HTTPS 时加 Secure；HttpOnly 防止 XSS 读取会话 */
export function sessionCookieOptions(requestUrl: string, httpOnly = true) {
  const secure = new URL(requestUrl).protocol === 'https:';
  return {
    path: '/',
    httpOnly,
    secure,
    sameSite: 'lax' as const,
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function clearCookieOptions(requestUrl: string, httpOnly: boolean) {
  const secure = new URL(requestUrl).protocol === 'https:';
  return { path: '/', httpOnly, secure, sameSite: 'lax' as const, maxAge: 0 };
}

export function encodeUserInfo(session: Session): string {
  // 注意：NextResponse.cookies.set() 会按 RFC 6265 自动编码一次，
  // 这里再 encodeURIComponent 会造成双重编码（%257B...），前端 decode 一次拿到的是
  // %7B... 而非 JSON，JSON.parse 失败后回退成 'default'，导致 /settings 等页面取不到用户。
  // 因此这里返回原始 JSON，让 cookie 层自行编码。
  return JSON.stringify({ username: session.username, role: session.role });
}

/**
 * TVBox 订阅令牌。
 * 优先使用独立的 TVBOX_TOKEN 环境变量（≥16 字符），它不参与会话签名，
 * 因此可以单独轮换而不影响任何登录会话；
 * 未配置时退回由会话密钥派生（轮换 SESSION_SECRET / AUTH_PASSWORD 即失效）。
 */
export async function getTvboxToken(): Promise<string | null> {
  const explicit = process.env.TVBOX_TOKEN;
  if (explicit && explicit.length >= 16) return explicit;
  const key = await getHmacKey();
  if (!key) return null;
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode('tvbox-token:v1'));
  return bytesToHex(new Uint8Array(mac));
}
