import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { TicketsService } from './tickets.service.js';
import { TicketGovernanceService } from './ticket-governance.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { unconfiguredCapabilities } from '../../capabilities.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let tickets: TicketsService;
beforeAll(async () => {
  fixture = await startTestDatabase();
  tickets = new TicketsService(fixture.db);
});
afterAll(async () => fixture?.stop());

async function member(role: Role, projectId: string): Promise<User> {
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: `Authority ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

async function scenario(executionStatus: 'waiting' | 'completed', ticketStatus: string) {
  const projectId = randomUUID();
  await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [projectId, 'Authority']);
  const client = await member('client', projectId);
  const technical = await member('technical', projectId);
  const admin = await member('admin', projectId);
  const ticket = await tickets.create(client, {
    title: 'Pedido gerido por fluxo',
    description: 'Fixture da autoridade única do motor de fluxos.',
    category: 'bug',
    environment: 'quality',
    priority: 'medium',
  });
  const flowId = randomUUID();
  const versionId = randomUUID();
  await fixture.db.query(
    `INSERT INTO flows(id,project_id,name,priority,flow_match,flow_definition)
     VALUES($1,$2,'Fluxo autoridade',10,'{}','{}')`,
    [flowId, projectId],
  );
  await fixture.db.query(
    `INSERT INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash)
     VALUES($1,$2,$3,1,'{}',$4)`,
    [versionId, flowId, projectId, 'f'.repeat(64)],
  );
  await fixture.db.query(
    `INSERT INTO flow_executions(id,ticket_id,project_id,flow_id,version_id,status,current_node)
     VALUES($1,$2,$3,$4,$5,$6,'review')`,
    [randomUUID(), ticket.id, projectId, flowId, versionId, executionStatus],
  );
  await fixture.db.query('UPDATE tickets SET status=$2 WHERE id=$1', [ticket.id, ticketStatus]);
  return { client, technical, admin, ticketId: ticket.id };
}

const status = async (ticketId: string) =>
  (await fixture.db.query<{ status: string }>('SELECT status FROM tickets WHERE id=$1', [ticketId]))
    .rows[0]?.status;

describe('autoridade única do fluxo (P11)', () => {
  it('rejeita resoluções e transições legadas enquanto a execução do fluxo está viva', async () => {
    const { client, technical, ticketId } = await scenario('waiting', 'awaiting_technical');
    const governance = new TicketGovernanceService(fixture.db);
    await expect(
      governance.proposeResolution(technical, ticketId, {
        expectedVersion: 0,
        body: 'Resposta humana fora do fluxo, que não pode saltar as etapas.',
      }),
    ).rejects.toMatchObject({ code: 'FLOW_MANAGED', status: 409 });
    await expect(
      governance.decideResolution(client, ticketId, {
        expectedVersion: 0,
        artifactHash: '0'.repeat(64),
        decision: 'approve',
        notes: 'Confirmo.',
      }),
    ).rejects.toMatchObject({ code: 'FLOW_MANAGED' });
    const workflow = new WorkflowService(fixture.db, unconfiguredCapabilities());
    await expect(
      workflow.transition(technical, ticketId, {
        expectedVersion: 0,
        action: 'cancel',
        notes: 'Cancelamento legado',
      }),
    ).rejects.toMatchObject({ code: 'FLOW_MANAGED' });
    expect(await status(ticketId)).toBe('awaiting_technical');
    expect(
      (await fixture.db.query('SELECT id FROM ticket_resolutions WHERE ticket_id=$1', [ticketId]))
        .rows,
    ).toEqual([]);
  });

  it('preserva o estado do motor em alterações da equipa num fluxo vivo', async () => {
    const { client, technical, admin, ticketId } = await scenario('waiting', 'awaiting_technical');
    await tickets.assign(admin, ticketId, {
      expectedVersion: 0,
      clientUserId: client.id,
      technicalUserId: technical.id,
      qaUserId: null,
      releaseUserId: null,
    });
    expect(await status(ticketId)).toBe('awaiting_technical');
    expect(
      (
        await fixture.db.query('SELECT id FROM ticket_events WHERE ticket_id=$1 AND to_status=$2', [
          ticketId,
          'investigating',
        ])
      ).rows,
    ).toEqual([]);
  });

  it('devolve a autoridade à equipa quando a execução terminou', async () => {
    const { client, technical, admin, ticketId } = await scenario('completed', 'blocked');
    await tickets.assign(admin, ticketId, {
      expectedVersion: 0,
      clientUserId: client.id,
      technicalUserId: technical.id,
      qaUserId: null,
      releaseUserId: null,
    });
    expect(await status(ticketId)).toBe('investigating');
  });
});
