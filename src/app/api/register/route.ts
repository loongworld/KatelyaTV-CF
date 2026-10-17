/* eslint-disable no-console,@typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import { getConfig, invalidateConfigCache } from '@/lib/config';
import { db } from '@/lib/db';
import {
  AUTH_COOKIE,
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

const USERNAME_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,32}$/;

export async function POST(req: NextRequest) {
  try {
    if (STORAGE_TYPE === 'localstorage') {
      return NextResponse.json({ error: '当前模式不支持注册' }, { status: 400 });
    }

    const config = await getConfig();
    if (!config.UserConfig.AllowRegister) {
      return NextResponse.json({ error: '当前未开放注册' }, { status: 400 });
    }

    const { username, password } = (await req.json().catch(() => ({}))) as {
      username?: unknown;
      password?: unknown;
    };
    if (!username || typeof username !== 'string') {
      return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
    }
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    }
    if (!USERNAME_PATTERN.test(username)) {
      return NextResponse.json(
        { error: '用户名 2-32 位，仅支持字母、数字、中文、下划线和短横线' },
        { status: 400 }
      );
    }
    if (password.length < 6 || password.length > 128) {
      return NextResponse.json({ error: '密码长度需为 6-128 位' }, { status: 400 });
    }
    if (process.env.USERNAME && username === process.env.USERNAME) {
      return NextResponse.json({ error: '用户已存在' }, { status: 400 });
    }

    try {
      const exist = await db.checkUserExist(username);
      if (exist) {
        return NextResponse.json({ error: '用户已存在' }, { status: 400 });
      }

      await db.registerUser(username, password);

      config.UserConfig.Users.push({ username, role: 'user' });
      await db.saveAdminConfig(config);
      invalidateConfigCache();

      const session: Session = { username, role: 'user' };
      const value = await createSessionValue(session);
      if (!value) {
        return NextResponse.json({ error: '服务端未配置会话密钥' }, { status: 500 });
      }
      const response = NextResponse.json({ ok: true });
      response.cookies.set(AUTH_COOKIE, value, sessionCookieOptions(req.url, true));
      response.cookies.set(
        USER_COOKIE,
        encodeUserInfo(session),
        sessionCookieOptions(req.url, false)
      );
      return response;
    } catch (err) {
      console.error('数据库注册失败', err);
      return NextResponse.json({ error: '数据库错误' }, { status: 500 });
    }
  } catch (error) {
    console.error('注册接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
