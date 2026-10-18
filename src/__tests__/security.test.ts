/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto';
import {
  TextDecoder as NodeTextDecoder,
  TextEncoder as NodeTextEncoder,
} from 'node:util';

import { hashPassword, isHashedPassword, verifyPassword } from '@/lib/password';
import { bytesToBase64Url } from '@/lib/secure';
import {
  createSessionValue,
  getTvboxToken,
  readCookie,
  verifySessionValue,
} from '@/lib/session';
import { bumpSessionVersion, isSessionVersionValid } from '@/lib/sessionVersion';

// jest 的 node 环境不注入 Web 标准全局，按需补齐
const globals = globalThis as unknown as Record<string, unknown>;
if (!globals.crypto) globals.crypto = webcrypto;
if (!globals.TextEncoder) globals.TextEncoder = NodeTextEncoder;
if (!globals.TextDecoder) globals.TextDecoder = NodeTextDecoder;
if (!globals.btoa) {
  globals.btoa = (input: string) => Buffer.from(input, 'binary').toString('base64');
}
if (!globals.atob) {
  globals.atob = (input: string) => Buffer.from(input, 'base64').toString('binary');
}

describe('password 哈希与明文兼容', () => {
  it('新密码写入 PBKDF2 哈希并可校验', async () => {
    const hashed = await hashPassword('s3cret-pass');
    expect(isHashedPassword(hashed)).toBe(true);
    expect(hashed.startsWith('pbkdf2_sha256$100000$')).toBe(true);
    await expect(verifyPassword('s3cret-pass', hashed)).resolves.toBe(true);
    await expect(verifyPassword('wrong-pass', hashed)).resolves.toBe(false);
    // 同一密码两次哈希不同（随机盐）
    await expect(hashPassword('s3cret-pass')).resolves.not.toBe(hashed);
  });

  it('存量明文密码仍可校验（供登录时无感升级）', async () => {
    await expect(verifyPassword('legacy-pass', 'legacy-pass')).resolves.toBe(true);
    await expect(verifyPassword('legacy-pass-x', 'legacy-pass')).resolves.toBe(false);
  });

  it('伪造的哈希格式不会崩溃', async () => {
    await expect(verifyPassword('x', 'pbkdf2_sha256$broken')).resolves.toBe(false);
    await expect(verifyPassword('x', 'pbkdf2_sha256$0$AA$AA')).resolves.toBe(false);
  });
});

describe('会话令牌签名', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.AUTH_PASSWORD = 'unit-test-password-0123456789';
    delete process.env.SESSION_SECRET;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('签发的会话可通过校验', async () => {
    const value = await createSessionValue({ username: 'owner', role: 'owner' });
    expect(typeof value).toBe('string');
    await expect(verifySessionValue(value as string)).resolves.toEqual({
      username: 'owner',
      role: 'owner',
      sv: 0,
    });
  });

  it('会话版本号随载荷往返', async () => {
    const value = await createSessionValue({ username: 'u1', role: 'user', sv: 7 });
    await expect(verifySessionValue(value as string)).resolves.toEqual({
      username: 'u1',
      role: 'user',
      sv: 7,
    });
  });

  it('篡改载荷（提权）会被拒绝', async () => {
    const value = (await createSessionValue({ username: 'u1', role: 'user' })) as string;
    const mac = value.split('.')[1];
    const forgedBody = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          v: 2,
          u: 'u1',
          r: 'owner',
          iat: 1,
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      )
    );
    await expect(verifySessionValue(`${forgedBody}.${mac}`)).resolves.toBeNull();
  });

  it('篡改签名会被拒绝', async () => {
    const value = (await createSessionValue({ username: 'u1', role: 'user' })) as string;
    const body = value.split('.')[0];
    await expect(verifySessionValue(`${body}.AAAA`)).resolves.toBeNull();
    await expect(verifySessionValue('not-a-token')).resolves.toBeNull();
  });

  it('过期会话会被拒绝', async () => {
    const value = (await createSessionValue({ username: 'u1', role: 'user' })) as string;
    const realNow = Date.now;
    Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
    try {
      await expect(verifySessionValue(value)).resolves.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('未配置任何密钥时 fail closed', async () => {
    const saved = process.env.AUTH_PASSWORD;
    delete process.env.AUTH_PASSWORD;
    delete process.env.SESSION_SECRET;
    await expect(createSessionValue({ username: 'u', role: 'user' })).resolves.toBeNull();
    process.env.AUTH_PASSWORD = saved;
  });
});

describe('TVBox 订阅令牌', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.AUTH_PASSWORD = 'unit-test-password-0123456789';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('由会话密钥派生且稳定（64 位十六进制）', async () => {
    delete process.env.TVBOX_TOKEN;
    const token = await getTvboxToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expect(getTvboxToken()).resolves.toBe(token);
  });

  it('配置 TVBOX_TOKEN 时优先使用独立令牌', async () => {
    process.env.TVBOX_TOKEN = 'my-explicit-tvbox-token-0123456789';
    await expect(getTvboxToken()).resolves.toBe('my-explicit-tvbox-token-0123456789');
  });

  it('TVBOX_TOKEN 过短（<16 字符）时回退派生令牌', async () => {
    process.env.TVBOX_TOKEN = 'too-short';
    const token = await getTvboxToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe('too-short');
  });
});

describe('会话版本校验（mock D1）', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete (globalThis as unknown as Record<string, unknown>).DB;
  });

  function mockD1(initialVersion: number | null) {
    let version = initialVersion;
    (globalThis as unknown as Record<string, unknown>).DB = {
      prepare(sql: string) {
        return {
          bind: () => ({
            first: async () => {
              if (sql.includes('SELECT session_version')) {
                return version === null ? null : { session_version: version };
              }
              return { ok: 1 };
            },
            run: async () => {
              if (sql.startsWith('UPDATE') && version !== null) version += 1;
              return { success: true };
            },
          }),
        };
      },
    };
  }

  it('版本一致放行、不一致拒绝、bump 后旧版本立即失效', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
    mockD1(3);

    await expect(isSessionVersionValid('u1', 3)).resolves.toBe(true);
    await expect(isSessionVersionValid('u1', 2)).resolves.toBe(false);

    await bumpSessionVersion('u1');
    // 缓存已在 bump 时清掉，下一次校验必须重新读库
    await expect(isSessionVersionValid('u1', 3)).resolves.toBe(false);
    await expect(isSessionVersionValid('u1', 4)).resolves.toBe(true);
  });

  it('用户不存在时拒绝（会话作废）', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
    mockD1(null);
    await expect(isSessionVersionValid('ghost-user', 0)).resolves.toBe(false);
  });

  it('D1 不可用时 fail-open（不把全站踢下线）', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
    // 不注入 globalThis.DB，getD1Database 会抛错
    await expect(isSessionVersionValid('u2-no-db', 0)).resolves.toBe(true);
  });

  it('非 d1 存储模式直接放行', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
    await expect(isSessionVersionValid('u3-local', 99)).resolves.toBe(true);
  });
});

describe('Cookie 解析', () => {
  it('从请求头中读取指定 Cookie', () => {
    const header = 'foo=1; auth=abc.def; kt_user=x';
    const request = {
      headers: { get: (name: string) => (name === 'cookie' ? header : null) },
    } as unknown as Request;
    expect(readCookie(request, 'auth')).toBe('abc.def');
    expect(readCookie(request, 'kt_user')).toBe('x');
    expect(readCookie(request, 'missing')).toBeNull();
  });
});
