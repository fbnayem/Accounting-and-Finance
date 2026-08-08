/**
 * Credential primitives: passwords, opaque session tokens, TOTP.
 *
 * All three are built on `node:crypto` rather than on dependencies. Not to avoid
 * dependencies for their own sake — the reason is that each one is a place where a
 * dependency's default settings become a security property of this system, and
 * scrypt parameters, token entropy and TOTP drift tolerance are decisions that
 * should be visible in this repository and reviewable in a diff.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * OWASP's 2024 scrypt guidance is N=2^17, r=8, p=1. `maxmem` has to be raised to
 * match: node's default is 32 MB and these parameters need ~128 MB, so leaving it
 * alone turns the recommended settings into a runtime error.
 */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const SCRYPT_KEYLEN = 32;

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing, so the cost can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];

  const expectedBuffer = Buffer.from(expected, 'base64url');
  const actual = await scrypt(
    password.normalize('NFKC'),
    Buffer.from(salt, 'base64url'),
    expectedBuffer.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem },
  );
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

/**
 * Burns roughly the same time as a real verification when the account does not
 * exist. Without it, response timing distinguishes "no such user" from "wrong
 * password", which turns the login route into an account enumeration oracle.
 */
export async function burnPasswordTime(): Promise<void> {
  await scrypt('not-a-real-password', randomBytes(16), SCRYPT_KEYLEN, SCRYPT);
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

/**
 * Session tokens are `<session-id>.<secret>`.
 *
 * The id makes the lookup a primary-key read instead of an index scan over a hash;
 * the secret is what is actually verified. ADR-0005 requires that revocation take
 * effect immediately, which means the session row is read on every request anyway,
 * so there is nothing to gain from a self-contained token and a denylist to lose.
 *
 * Only the SHA-256 of the secret is stored. A fast hash is right here and wrong for
 * passwords: this secret is 256 bits from a CSPRNG, so there is no dictionary to
 * run and no reason to make legitimate verification slow.
 */
export interface IssuedToken {
  readonly token: string;
  readonly hash: string;
}

export function issueToken(sessionId: string): IssuedToken {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${sessionId}.${secret}`, hash: hashToken(secret) };
}

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

export function splitToken(token: string): { sessionId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { sessionId: token.slice(0, dot), secret: token.slice(dot + 1) };
}

/** Constant-time comparison of two base64url digests of equal length. */
export function tokenMatches(secret: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashToken(secret));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A single-use credential mailed to someone — an invitation, a recovery code. */
export function issueOpaqueSecret(bytes = 32): { secret: string; hash: string } {
  const secret = randomBytes(bytes).toString('base64url');
  return { secret, hash: hashToken(secret) };
}

// ---------------------------------------------------------------------------
// TOTP — RFC 6238
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side. Wider windows trade replay resistance for clock slop. */
export const TOTP_DRIFT_STEPS = 1;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Returns the step the code belongs to, or null.
 *
 * The step is returned rather than a boolean because the caller must persist it:
 * a TOTP code stays valid for its whole step, so without recording the last
 * accepted one, a code observed in transit can be replayed until the step ends.
 * `mfa_factors.last_used_step` is where it goes.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  options: { atMs?: number; lastUsedStep?: number | null } = {},
): number | null {
  const trimmed = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return null;

  const current = totpStep(options.atMs ?? Date.now());
  const candidate = Buffer.from(trimmed);
  for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset++) {
    const step = current + offset;
    if (options.lastUsedStep != null && step <= options.lastUsedStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return step;
  }
  return null;
}

export function totpUri(secret: Buffer, account: string, issuer: string): string {
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params}`;
}

// ---------------------------------------------------------------------------
// TOTP secret storage
// ---------------------------------------------------------------------------

/**
 * A TOTP secret is the one credential here that cannot be hashed, because
 * verification needs it back. It is encrypted under a key held outside the
 * database, which is what makes a database dump alone insufficient to mint codes.
 */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authTag: Buffer;
}

export function encryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM; got ${key.length}.`,
    );
  }
  return key;
}

export function sealSecret(secret: Buffer, key: Buffer): SealedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

export function openSecret(sealed: SealedSecret, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

export function newTotpSecret(): Buffer {
  return randomBytes(20); // RFC 4226 §4 recommends 160 bits for HMAC-SHA1.
}
