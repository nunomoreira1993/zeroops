import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/backend/src/modules/notifications/identity-mail.test.ts'],
    testTimeout: 10000,
  },
});
