import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './credentials.js';

describe('password credentials', () => {
  it('uses independent random salts and only verifies the original password', async () => {
    const password = 'A-long-random-test-password!';
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(`${password}x`, first)).toBe(false);
  });

  it('rejects absent, malformed, and unsupported parameter hashes without accepting passwords', async () => {
    for (const hash of [null, 'not-a-hash', 'scrypt$2147483648$8$1$bad$bad']) {
      expect(await verifyPassword('A-long-test-password!', hash)).toBe(false);
    }
  });
});
