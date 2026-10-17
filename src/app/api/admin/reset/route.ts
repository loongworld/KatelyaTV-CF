/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { resetConfig } from '@/lib/config';

export const runtime = 'edge';

/**
 * 重置站点配置为默认值。仅站长可调用，且必须显式携带确认字段，
 * 避免误触发或 CSRF 式的 GET 触发。
 */
export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json({ error: '不支持本地存储进行管理员配置' }, { status: 400 });
  }

  const authInfo = await getAuthInfoFromCookie(request);
  if (!authInfo) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (authInfo.role !== 'owner') {
    return NextResponse.json({ error: '仅支持站长重置配置' }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { confirm?: unknown };
  if (body?.confirm !== 'RESET') {
    return NextResponse.json({ error: '缺少确认字段 confirm=RESET' }, { status: 400 });
  }

  try {
    await resetConfig();
    return NextResponse.json(
      { ok: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('重置管理员配置失败:', error);
    return NextResponse.json(
      { error: '重置管理员配置失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
