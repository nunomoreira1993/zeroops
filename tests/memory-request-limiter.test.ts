import { describe, expect, it } from 'vitest';
import { MemoryRequestLimiter } from '../apps/api/src/http/memory-request-limiter.js';

describe('MemoryRequestLimiter', () => {
  it('conta por chave dentro da janela e recomeça quando expira', () => {
    let now = 0;
    const limiter = new MemoryRequestLimiter(1000, 10, () => now);
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('b')]).toEqual([1, 2, 1]);
    now = 1000;
    expect(limiter.hit('a')).toBe(1);
  });

  it('não cresce sem limite de chaves', () => {
    let now = 0;
    const limiter = new MemoryRequestLimiter(1000, 2, () => now);
    limiter.hit('a');
    limiter.hit('b');
    limiter.hit('c');
    expect(limiter.hit('a')).toBe(1);
    now = 500;
    expect(limiter.hit('a')).toBe(2);
  });
});
