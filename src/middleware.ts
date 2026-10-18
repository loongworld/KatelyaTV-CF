import { NextRequest, NextResponse } from 'next/server';

import { getSessionFromRequest } from '@/lib/session';

/**
 * 默认全部路径需要有效会话（签名 Cookie）。以下路径不需要会话：
 * - 登录与登出相关页面和接口
 * - 站点公共配置（仅返回站点名与存储类型）
 * - 图片代理：无 Cookie 客户端（OrionTV / TVBox）要靠它加载海报，路由内已有
 *   SSRF 拦截 + MIME 白名单 + 体积/超时限制，详见 api/image-proxy/route.ts
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
  '/api/image-proxy',
  '/api/tvbox',
  '/api/cron',
  '/favicon.ico',
  '/robots.txt',
  '/manifest.json',
  '/sw.js',
]);

const PUBLIC_PREFIX = ['/_next/', '/icons/', '/workbox-', '/swe-worker', '/fallback'];

/**
 * public/ 下的静态资源按扩展名放行，避免每新增一个文件就要回来改白名单
 * （历史上就漏过 screenshot1-4.png / wechat.jpg，被 302 到登录页）。
 * 带斜杠保护的 API 路径不受此规则影响。
 */
const PUBLIC_FILE_EXT =
  /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|txt|xml|webmanifest|json|woff2?|ttf|otf|mp4|webm)$/i;

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (PUBLIC_PREFIX.some((prefix) => pathname.startsWith(prefix))) return true;
  if (!pathname.startsWith('/api/') && PUBLIC_FILE_EXT.test(pathname)) return true;
  return false;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CORS 预检不携带 Cookie，必须无条件放行，否则跨域客户端（OrionTV 等）
  // 的所有请求都会卡在 401 预检上。各路由自己的 OPTIONS 只返回 CORS 头，不泄露数据。
  if (request.method === 'OPTIONS') {
    return NextResponse.next();
  }

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
