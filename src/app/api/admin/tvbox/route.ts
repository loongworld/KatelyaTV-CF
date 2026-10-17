import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getTvboxToken } from '@/lib/session';

export const runtime = 'edge';

/**
 * 站长专用：获取带订阅令牌的 TVBox 配置地址。
 * 令牌由会话密钥派生，不在前端硬编码，也不随公开页面输出。
 */
export async function GET(request: NextRequest) {
  const authInfo = await getAuthInfoFromCookie(request);
  if (!authInfo) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (authInfo.role !== 'owner') {
    return NextResponse.json({ error: '仅站长可获取订阅地址' }, { status: 403 });
  }

  const token = await getTvboxToken();
  if (!token) {
    return NextResponse.json(
      { error: '服务端未配置会话密钥，无法生成订阅令牌' },
      { status: 503 }
    );
  }

  const { searchParams, origin } = new URL(request.url);
  const format = searchParams.get('format') === 'txt' ? 'txt' : 'json';
  const url = `${origin}/api/tvbox?format=${format}&token=${token}`;

  return NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store' } });
}
