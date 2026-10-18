/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import { UserSettings } from '@/lib/types';

// 设置运行时为 Edge Runtime，确保部署兼容性
export const runtime = 'edge';

const NO_STORE = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

const DEFAULT_SETTINGS: UserSettings = {
  filter_adult_content: true,
  theme: 'auto',
  language: 'zh-CN',
  auto_play: true,
  video_quality: 'auto',
};

// 用户可自行修改的字段白名单（不包含管理员专属字段）
const USER_EDITABLE = ['filter_adult_content', 'theme', 'language', 'auto_play', 'video_quality'] as const;

function sanitize(input: Record<string, unknown>): Partial<UserSettings> {
  const out: Record<string, unknown> = {};
  for (const key of USER_EDITABLE) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === 'filter_adult_content' || key === 'auto_play') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (typeof value === 'string' && value.length <= 32) {
      out[key] = value;
    }
  }
  return out as Partial<UserSettings>;
}

// 获取用户设置（身份只来自签名 Cookie）
export async function GET(request: NextRequest) {
  try {
    const authInfo = await getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: '未授权访问' }, { status: 401 });
    }

    const storage = getStorage();
    const settings = await storage.getUserSettings(authInfo.username);
    return NextResponse.json({ settings: settings || DEFAULT_SETTINGS }, { headers: NO_STORE });
  } catch (error) {
    console.error('Error getting user settings:', error);
    return NextResponse.json({ error: '获取用户设置失败' }, { status: 500 });
  }
}

// 更新用户设置
export async function PATCH(request: NextRequest) {
  try {
    const authInfo = await getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: '未授权访问' }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { settings?: Record<string, unknown> };
    if (!body.settings || typeof body.settings !== 'object') {
      return NextResponse.json({ error: '设置数据不能为空' }, { status: 400 });
    }

    const storage = getStorage();
    const current = (await storage.getUserSettings(authInfo.username)) || DEFAULT_SETTINGS;
    const patch = sanitize(body.settings);

    // 管理员强制开启过滤或禁止用户自行关闭时，用户不能改成关闭
    const locked = current.can_disable_filter === false || current.managed_by_admin === true;
    if (locked && patch.filter_adult_content === false) {
      return NextResponse.json({ error: '管理员已限制关闭成人内容过滤' }, { status: 403 });
    }

    await storage.updateUserSettings(authInfo.username, patch);
    return NextResponse.json(
      { success: true, message: '设置更新成功' },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error('Error updating user settings:', error);
    return NextResponse.json({ error: '更新用户设置失败' }, { status: 500 });
  }
}

// 重置用户设置为默认值
export async function PUT(request: NextRequest) {
  try {
    const authInfo = await getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: '未授权访问' }, { status: 401 });
    }

    const storage = getStorage();
    const current = await storage.getUserSettings(authInfo.username);

    // 只重置用户可编辑项，管理员下发的托管字段必须原样保留，
    // 否则用户点一次「重置」就能解开管理员强开的成人内容过滤
    const next: UserSettings = { ...DEFAULT_SETTINGS };
    if (current && current.can_disable_filter !== undefined) {
      next.can_disable_filter = current.can_disable_filter;
    }
    if (current && current.managed_by_admin !== undefined) {
      next.managed_by_admin = current.managed_by_admin;
    }

    await storage.setUserSettings(authInfo.username, next);
    return NextResponse.json({ success: true, message: '设置已重置' });
  } catch (error) {
    console.error('Error resetting user settings:', error);
    return NextResponse.json({ error: '重置用户设置失败' }, { status: 500 });
  }
}
