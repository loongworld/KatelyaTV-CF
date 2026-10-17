import {
  base64ToBytes,
  bytesToBase64,
  timingSafeEqualBytes,
  timingSafeEqualString,
} from './secure';

// Workers 运行时 PBKDF2 的迭代上限为 100000
const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'pbkdf2_sha256';
const encoder = new TextEncoder();

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS, KEY_BYTES);
  return `${PREFIX}$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export function isHashedPassword(stored: string): boolean {
  return stored.startsWith(`${PREFIX}$`);
}

/**
 * 校验密码。存量账号可能仍是明文（早期版本），这里兼容明文比较，
 * 调用方在校验通过后应调用 hashPassword 把明文升级为哈希。
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  if (!isHashedPassword(stored)) {
    return timingSafeEqualString(password, stored);
  }
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000000) {
    return false;
  }
  const salt = base64ToBytes(parts[2]);
  const expected = base64ToBytes(parts[3]);
  const actual = await derive(password, salt, iterations, expected.length);
  return timingSafeEqualBytes(actual, expected);
}
