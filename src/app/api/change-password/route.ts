/* eslint-disable no-console*/

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import { IStorage } from '@/lib/types';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  // 不支持 localstorage 模式
  if (storageType === 'localstorage') {
    return NextResponse.json({ error: '不支持本地存储模式修改密码' }, { status: 400 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      oldPassword?: unknown;
      newPassword?: unknown;
    };

    // 身份只来自签名 Cookie
    const authInfo = await getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;

    const { oldPassword, newPassword } = body;
    if (!newPassword || typeof newPassword !== 'string') {
      return NextResponse.json({ error: '新密码不得为空' }, { status: 400 });
    }
    if (newPassword.length < 6 || newPassword.length > 128) {
      return NextResponse.json({ error: '新密码长度需为 6-128 位' }, { status: 400 });
    }
    if (!oldPassword || typeof oldPassword !== 'string') {
      return NextResponse.json({ error: '请输入当前密码' }, { status: 400 });
    }

    // 站长密码由环境变量管理，不能通过此接口修改
    if (username === process.env.USERNAME) {
      return NextResponse.json({ error: '站长不能通过此接口修改密码' }, { status: 403 });
    }

    const storage: IStorage | null = getStorage();
    if (!storage || typeof storage.changePassword !== 'function' || typeof storage.verifyUser !== 'function') {
      return NextResponse.json({ error: '存储服务不支持修改密码' }, { status: 500 });
    }

    // 修改前必须验证当前密码，防止仅凭被盗的 Cookie 改密
    const passed = await storage.verifyUser(username, oldPassword);
    if (!passed) {
      return NextResponse.json({ error: '当前密码不正确' }, { status: 401 });
    }

    await storage.changePassword(username, newPassword);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('修改密码失败:', error);
    return NextResponse.json({ error: '修改密码失败' }, { status: 500 });
  }
}
