import { NextRequest, NextResponse } from 'next/server';

import { AUTH_COOKIE, clearCookieOptions, USER_COOKIE } from '@/lib/session';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, '', clearCookieOptions(req.url, true));
  response.cookies.set(USER_COOKIE, '', clearCookieOptions(req.url, false));
  return response;
}
