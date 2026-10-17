/* eslint-disable no-console,@typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getD1Database } from '@/lib/d1.db';
import { db } from '@/lib/db';
import {
  clearLoginFailures,
  clientIp,
  getLoginLockSeconds,
  recordLoginFailure,
} from '@/lib/loginLimiter';
import { timingSafeEqualString } from '@/lib/secure';
import {
  AUTH_COOKIE,
  clearCookieOptions,
  createSessionValue,
  encodeUserInfo,
  Session,
  sessionCookieOptions,
  USER_COOKIE,
} from '@/lib/session';

export const runtime = 'edge';

// 读取存储类型环境变量，默认 localstorage
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'd1'
    | 'upstash'
    | undefined) || 'localstorage';

function safeGetD1(): any {
  try {
    return getD1Database();
  } catch {
    return null;
  }
}

function setSessionCookies(
  response: NextResponse,
  requestUrl: string,
  session: Session,
  value: string
) {
  response.cookies.set(AUTH_COOKIE, value, sessionCookieOptions(requestUrl, true));
  response.cookies.set(
    USER_COOKIE,
    encodeUserInfo(session),
    sessionCookieOptions(requestUrl, false)
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      username?: unknown;
      password?: unknown;
    } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const envPassword = process.env.AUTH_PASSWORD;

    // 本地 / localStorage 模式——仅校验固定密码
    if (STORAGE_TYPE === 'localstorage') {
      if (!envPassword) {
        const response = NextResponse.json({ ok: true });
        response.cookies.set(AUTH_COOKIE, '', clearCookieOptions(req.url, true));
        response.cookies.set(USER_COOKIE, '', clearCookieOptions(req.url, false));
        return response;
      }
      if (!password) {
        return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
      }
      if (!timingSafeEqualString(password, envPassword)) {
        return NextResponse.json({ ok: false, error: '密码错误' }, { status: 401 });
      }
      const session: Session = { username: '', role: 'user' };
      const value = await createSessionValue(session);
      if (!value) {
        return NextResponse.json({ error: '服务端未配置会话密钥' }, { status: 500 });
      }
      const response = NextResponse.json({ ok: true });
      setSessionCookies(response, req.url, session, value);
      return response;
    }

    // 数据库模式：校验用户名与密码，并做失败限速
    if (!username) return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
    if (!password) return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    if (!envPassword) {
      return NextResponse.json({ error: '服务端未配置 AUTH_PASSWORD' }, { status: 500 });
    }

    const rawDb = safeGetD1();
    const keys = [`ip:${clientIp(req)}`, `user:${username.toLowerCase()}`];
    const lockSeconds = await getLoginLockSeconds(rawDb, keys);
    if (lockSeconds > 0) {
      return NextResponse.json(
        { error: `尝试次数过多，请 ${Math.ceil(lockSeconds / 60)} 分钟后再试` },
        { status: 429, headers: { 'Retry-After': String(lockSeconds) } }
      );
    }

    let session: Session | null = null;
    let banned = false;

    if (process.env.USERNAME && username === process.env.USERNAME) {
      // 站长账号：凭据来自环境变量
      if (timingSafeEqualString(password, envPassword)) {
        session = { username, role: 'owner' };
      }
    } else {
      const passed = await db.verifyUser(username, password);
      if (passed) {
        const config = await getConfig();
        const user = config.UserConfig.Users.find((u) => u.username === username);
        banned = !!user?.banned;
        session = { username, role: user?.role === 'admin' ? 'admin' : 'user' };
      }
    }

    if (banned) {
      return NextResponse.json({ error: '用户被封禁' }, { status: 401 });
    }
    if (!session) {
      await recordLoginFailure(rawDb, keys);
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    await clearLoginFailures(rawDb, keys);
    const value = await createSessionValue(session);
    if (!value) {
      return NextResponse.json({ error: '服务端未配置会话密钥' }, { status: 500 });
    }
    const response = NextResponse.json({ ok: true });
    setSessionCookies(response, req.url, session, value);
    return response;
  } catch (error) {
    console.error('登录接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
