import { NextRequest, NextResponse } from 'next/server';

import { getSessionFromRequest } from '@/lib/session';

/**
 * 默认全部路径需要有效会话（签名 Cookie）。以下路径不需要会话：
 * - 登录与登出相关页面和接口
 * - 站点公共配置（仅返回站点名与存储类型）
 * - TVBox 与定时任务接口：各自使用独立令牌 / 密钥校验，见对应路由
 * - 静态资源与 PWA 文件
 */
const PUBLIC_EXACT = new Set([
  '/login',
  '/warning',
  '/api/login',
  '/api/register',
  '/api/logout',
  '/api/server-config',
  '/api/tvbox',
  '/api/cron',
  '/favicon.ico',
  '/robots.txt',
  '/manifest.json',
  '/logo.png',
  '/screenshot.png',
  '/sw.js',
]);

const PUBLIC_PREFIX = ['/_next/', '/icons/', '/workbox-', '/swe-worker', '/fallback'];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIX.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (!process.env.AUTH_PASSWORD) {
    return NextResponse.redirect(new URL('/warning', request.url));
  }

  const session = await getSessionFromRequest(request);
  if (!session) {
    return handleAuthFailure(request, pathname);
  }

  return NextResponse.next();
}

// 处理认证失败的情况
function handleAuthFailure(request: NextRequest, pathname: string): NextResponse {
  if (pathname.startsWith('/api')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  const fullUrl = `${pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set('redirect', fullUrl);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
