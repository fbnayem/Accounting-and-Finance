import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  encryptionKey,
  hashPassword,
  issueOpaqueSecret,
  issueToken,
  newTotpSecret,
  openSecret,
  sealSecret,
  splitToken,
  tokenMatches,
  totpCode,
  verifyPassword,
  verifyTotp,
} from './credentials';

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('correct-horse-battery-staple', stored)).toBe(true);
    expect(await verifyPassword('Correct-horse-battery-staple', stored)).toBe(false);
  });

  it('produces a different hash every time', async () => {
    // Distinct salts. Without them, identical passwords are visibly identical in
    // the table, which turns one leaked hash into a list of who shares it.
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-here', b)).toBe(true);
  });

  it('records its own parameters so the cost can be raised later', async () => {
    const stored = await hashPassword('parameterised');
    const [algorithm, n, r, p] = stored.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(n)).toBe(2 ** 17);
    expect([Number(r), Number(p)]).toEqual([8, 1]);
  });

  it('normalises Unicode before hashing', async () => {
    // é as one code point and as e + combining accent are the same password to the
    // person typing it, and different byte strings to everything else. NFKC first.
    const composed = await hashPassword('café-password');
    expect(await verifyPassword('café-password', composed)).toBe(true);
  });

  it('rejects a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('session tokens', () => {
  it('round-trips and verifies', () => {
    const issued = issueToken('019fdcac-1858-7d9b-8114-efbe28715754');
    const parts = splitToken(issued.token)!;
    expect(parts.sessionId).toBe('019fdcac-1858-7d9b-8114-efbe28715754');
    expect(tokenMatches(parts.secret, issued.hash)).toBe(true);
    expect(tokenMatches('wrong', issued.hash)).toBe(false);
  });

  it('rejects a token with no separator or no secret', () => {
    expect(splitToken('no-dot-here')).toBeNull();
    expect(splitToken('.leading')).toBeNull();
    expect(splitToken('trailing.')).toBeNull();
  });

  it('never matches a null stored hash', () => {
    // Revocation nulls the hash. If an empty stored hash matched anything, revoking
    // a session would make every token valid for it.
    expect(tokenMatches('anything', null)).toBe(false);
  });

  it('issues distinct secrets', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => issueOpaqueSecret().secret));
    expect(secrets.size).toBe(50);
  });
});

describe('TOTP', () => {
  it('matches RFC 6238 test vectors', () => {
    // RFC 6238 Appendix B, SHA-1, seed "12345678901234567890".
    const secret = Buffer.from('12345678901234567890', 'ascii');
    const at = (unix: number) => Math.floor(unix / TOTP_STEP_SECONDS);
    expect(totpCode(secret, at(59))).toBe('287082');
    expect(totpCode(secret, at(1111111109))).toBe('081804');
    expect(totpCode(secret, at(1111111111))).toBe('050471');
    expect(totpCode(secret, at(1234567890))).toBe('005924');
    expect(totpCode(secret, at(2000000000))).toBe('279037');
  });

  it('accepts one step of drift either way', () => {
    const secret = newTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp(secret, totpCode(secret, step + offset), { atMs: now })).toBe(
        step + offset,
      );
    }
    expect(verifyTotp(secret, totpCode(secret, step + 2), { atMs: now })).toBeNull();
  });

  it('refuses to reuse a code within its own window', () => {
    // A TOTP code stays valid for its whole step, so without recording the last
    // accepted one a code observed in transit works again until the step ends.
    const secret = newTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    const code = totpCode(secret, step);

    expect(verifyTotp(secret, code, { atMs: now })).toBe(step);
    expect(verifyTotp(secret, code, { atMs: now, lastUsedStep: step })).toBeNull();
    // And the next step's code still works, so replay defence is not a lockout.
    expect(verifyTotp(secret, totpCode(secret, step + 1), { atMs: now, lastUsedStep: step })).toBe(
      step + 1,
    );
  });

  it('rejects anything that is not six digits', () => {
    const secret = newTotpSecret();
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56x']) {
      expect(verifyTotp(secret, code)).toBeNull();
    }
  });

  it('round-trips base32', () => {
    for (const input of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      const buffer = Buffer.from(input, 'ascii');
      expect(base32Decode(base32Encode(buffer))).toEqual(buffer);
    }
  });
});

describe('TOTP secret sealing', () => {
  const key = encryptionKey(Buffer.from('development_only_mfa_key_32bytes').toString('base64'));

  it('round-trips a secret', () => {
    const secret = newTotpSecret();
    expect(openSecret(sealSecret(secret, key), key)).toEqual(secret);
  });

  it('uses a fresh nonce every time', () => {
    const secret = newTotpSecret();
    const a = sealSecret(secret, key);
    const b = sealSecret(secret, key);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('refuses a tampered ciphertext', () => {
    // The authentication tag is the point of GCM: a modified secret must fail
    // loudly rather than decrypt to something that produces wrong codes forever.
    const sealed = sealSecret(newTotpSecret(), key);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => openSecret({ ...sealed, ciphertext: tampered }, key)).toThrow();
  });

  it('refuses a key of the wrong length', () => {
    expect(() => encryptionKey(Buffer.from('too-short').toString('base64'))).toThrow(/32 bytes/);
  });
});
