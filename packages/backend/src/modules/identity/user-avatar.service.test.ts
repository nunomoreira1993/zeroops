import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { UserAvatarService } from './user-avatar.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let avatars: UserAvatarService;

beforeAll(async () => {
  fixture = await startTestDatabase();
  avatars = new UserAvatarService(fixture.db);
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects (id,name) VALUES ($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, `Avatar ${projectId}`],
  );
  const actor: User = {
    id: randomUUID(),
    projectId,
    email: `${randomUUID()}@example.test`,
    displayName: 'Avatar test',
    role: 'technical',
  };
  await fixture.db.query(
    "INSERT INTO users(id,project_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,'technical','unusable-test-hash')",
    [actor.id, projectId, actor.email, actor.displayName],
  );
  return actor;
}

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]);
const base64 = (value: Buffer | string) => Buffer.from(value).toString('base64');

describe('UserAvatarService', () => {
  it('guarda a fotografia do próprio e só a mostra a quem partilha um projeto', async () => {
    const owner = await member();
    const colleague = await member(owner.projectId);
    const outsider = await member();

    await expect(
      avatars.update(owner, { mime: 'image/jpeg', data: base64(png) }),
    ).rejects.toMatchObject({ code: 'INVALID_AVATAR' });
    expect(await avatars.update(owner, { mime: 'image/png', data: base64(png) })).toEqual({
      avatarVersion: 1,
    });
    expect(await avatars.update(owner, { mime: 'image/png', data: base64(png) })).toEqual({
      avatarVersion: 2,
    });

    expect((await avatars.read(colleague, owner.id)).data.equals(png)).toBe(true);
    await expect(avatars.read(outsider, owner.id)).rejects.toMatchObject({ status: 404 });

    await avatars.remove(owner);
    await expect(avatars.read(owner, owner.id)).rejects.toMatchObject({ status: 404 });
  });
});
