import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { IdentityService } from './identity.service.js';
import { ProjectLogoService } from './project-logo.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let logos: ProjectLogoService;

beforeAll(async () => {
  fixture = await startTestDatabase();
  logos = new ProjectLogoService(fixture.db);
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(instanceAdmin = false): Promise<User> {
  const projectId = randomUUID();
  const actor: User = {
    id: randomUUID(),
    projectId,
    email: `${randomUUID()}@example.test`,
    displayName: 'Logo test',
    role: 'admin',
    organization: null,
    locale: 'pt-PT',
    instanceAdmin,
  };
  await fixture.db.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [
    projectId,
    `Logo ${projectId}`,
  ]);
  await fixture.db.query(
    "INSERT INTO users(id,project_id,email,display_name,role,password_hash,instance_admin) VALUES($1,$2,$3,$4,'admin','unusable-test-hash',$5)",
    [actor.id, projectId, actor.email, actor.displayName, instanceAdmin],
  );
  return actor;
}

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]);
const base64 = (value: string | Buffer) => Buffer.from(value).toString('base64');

describe('ProjectLogoService', () => {
  it('lets instance admins replace the logo and members read it with a new version', async () => {
    const owner = await member();
    const admin = await member(true);
    const outsider = await member();
    await expect(
      logos.update(owner, owner.projectId, { mime: 'image/png', data: base64(png) }),
    ).rejects.toMatchObject({ status: 403 });

    const saved = await logos.update(admin, owner.projectId, {
      mime: 'image/png',
      data: base64(png),
    });
    expect(saved.logoVersion).toBe(1);
    const logo = await logos.read(owner, owner.projectId);
    expect(logo.mime).toBe('image/png');
    expect(Buffer.compare(logo.data, png)).toBe(0);
    await expect(logos.read(outsider, owner.projectId)).rejects.toMatchObject({ status: 404 });
    const [project] = await new IdentityService(fixture.db).projects(owner);
    expect(project?.logoVersion).toBe(1);

    expect((await logos.remove(admin, owner.projectId)).logoVersion).toBeNull();
    await expect(logos.read(owner, owner.projectId)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects content that does not match the declared type or SVG with scripts', async () => {
    const admin = await member(true);
    await expect(
      logos.update(admin, admin.projectId, { mime: 'image/png', data: base64('<svg></svg>') }),
    ).rejects.toMatchObject({ code: 'INVALID_LOGO' });
    await expect(
      logos.update(admin, admin.projectId, {
        mime: 'image/svg+xml',
        data: base64('<svg onload="alert(1)"></svg>'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LOGO' });
    await expect(
      logos.update(admin, admin.projectId, {
        mime: 'image/svg+xml',
        data: base64('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
      }),
    ).resolves.toMatchObject({ logoVersion: 1 });
  });
});
