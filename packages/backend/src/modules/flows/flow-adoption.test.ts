import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { createFlowActionRegistry } from '../incidents/incident.module.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { FlowAdoptionService } from './flow-adoption.js';
import { FlowEngine } from './flow-engine.js';
import { FlowsService } from './flows.service.js';

/** P11 — migração explícita e auditada dos tickets antigos sem execução (sem backfill). */

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let engine: FlowEngine;
let flows: FlowsService;
let adoption: FlowAdoptionService;
// Sem hooks: reproduz tickets criados antes dos fluxos (ou sem fluxo ativo).
let legacyTickets: TicketsService;

beforeAll(async () => {
  fixture = await startTestDatabase();
  engine = new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db));
  flows = new FlowsService(fixture.db, engine);
  adoption = new FlowAdoptionService(fixture.db, engine);
  legacyTickets = new TicketsService(fixture.db);
});
afterAll(async () => fixture?.stop());

async function member(projectId: string, role: Role): Promise<User> {
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: `Pessoa ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users(id,project_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

async function project() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [id, `P11 ${id}`]);
  const admin = await member(id, 'admin');
  const author = await member(id, 'client');
  const technical = await member(id, 'technical');
  const ticket = (title: string) =>
    legacyTickets.create(author, {
      title,
      description: 'Pedido antigo sem execução de fluxo.',
      category: 'bug',
      environment: 'quality',
      priority: 'medium',
    });
  return { id, admin, author, technical, ticket };
}

async function activateGeneral(admin: User, projectId: string) {
  const general = (await flows.list(admin, projectId)).find((flow) => flow.template === 'general')!;
  const current = await flows.get(admin, projectId, general.id);
  await flows.publish(admin, projectId, general.id, { expectedDraftVersion: current.draftVersion });
  return general.id;
}

const count = async (sql: string, params: unknown[]) =>
  Number((await fixture.db.query<{ total: number }>(sql, params)).rows[0]?.total ?? 0);

describe('adoção explícita de tickets antigos (P11)', () => {
  it('não existe backfill automático: tickets antigos ficam sem execução até decisão auditada', async () => {
    const p = await project();
    const a = await p.ticket('Pedido antigo A');
    const b = await p.ticket('Pedido antigo B');
    await activateGeneral(p.admin, p.id);
    expect('backfill' in engine).toBe(false);
    await engine.tick(50);
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_executions WHERE project_id=$1', [p.id]),
    ).toBe(0);

    const plan = await adoption.plan(p.admin, p.id);
    expect(plan.candidates.map((item) => item.ticketId).sort()).toEqual([a.id, b.id].sort());
    await expect(adoption.plan(p.technical, p.id)).rejects.toMatchObject({ status: 403 });
    await expect(
      adoption.apply(p.admin, {
        projectId: p.id,
        disposition: 'start',
        reason: 'Migração P11 de teste',
        expect: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'STALE_SELECTION' });

    const started = await adoption.apply(p.admin, {
      projectId: p.id,
      disposition: 'start',
      reason: 'Migração P11 de teste',
      expect: plan.digest,
      ticketIds: [a.id],
    });
    expect(started.results).toMatchObject([{ ticketId: a.id, outcome: 'started' }]);
    const execution = (
      await fixture.db.query<{ id: string; version_id: string }>(
        'SELECT id,version_id FROM flow_executions WHERE ticket_id=$1',
        [a.id],
      )
    ).rows[0]!;
    expect(execution.id).toBe(started.results[0]!.executionId);
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM audit_events WHERE ticket_id=$1 AND action='ticket.flow_adoption'",
        [a.id],
      ),
    ).toBe(1);

    // O hash antigo deixa de valer (A já não é candidato); B fica fora dos fluxos explicitamente.
    await expect(
      adoption.apply(p.admin, {
        projectId: p.id,
        disposition: 'exclude',
        reason: 'Migração P11 de teste',
        expect: plan.digest,
      }),
    ).rejects.toMatchObject({ code: 'STALE_SELECTION' });
    const next = await adoption.plan(p.admin, p.id);
    expect(next.candidates.map((item) => item.ticketId)).toEqual([b.id]);
    const excluded = await adoption.apply(p.admin, {
      projectId: p.id,
      disposition: 'exclude',
      reason: 'Tratado pela equipa fora dos fluxos',
      expect: next.digest,
    });
    expect(excluded.results).toMatchObject([{ ticketId: b.id, outcome: 'excluded' }]);
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_executions WHERE ticket_id=$1', [b.id]),
    ).toBe(0);
    expect((await adoption.plan(p.admin, p.id)).candidates).toEqual([]);

    const inventory = await adoption.inventory(p.admin, p.id);
    expect(inventory.adoptions).toEqual({ start: 1, exclude: 1 });
    expect(Object.values(inventory.executions).reduce((a, b) => a + b, 0)).toBe(1);
    expect(inventory.adoptionCandidates).toBe(0);
    // A adoção entra na decisão da equipa sem mexer no estado do ticket.
    expect(
      (await fixture.db.query<{ status: string }>('SELECT status FROM tickets WHERE id=$1', [a.id]))
        .rows[0]!.status,
    ).toBe(a.status);
  });

  it('não reassocia tickets com execução nem toca noutros projetos', async () => {
    const p = await project();
    const other = await project();
    await activateGeneral(p.admin, p.id);
    const current = await p.ticket('Pedido antigo do projeto');
    const foreign = await other.ticket('Pedido de outro projeto');
    const before = await adoption.inventory(p.admin, p.id);
    const plan = await adoption.plan(p.admin, p.id);
    expect(plan.candidates.map((item) => item.ticketId)).toEqual([current.id]);
    await expect(
      adoption.apply(p.admin, {
        projectId: p.id,
        disposition: 'start',
        reason: 'Migração P11 de teste',
        expect: plan.digest,
        ticketIds: [foreign.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(adoption.plan(p.admin, other.id)).rejects.toMatchObject({ status: 403 });
    await adoption.apply(p.admin, {
      projectId: p.id,
      disposition: 'start',
      reason: 'Migração P11 de teste',
      expect: plan.digest,
    });
    const bound = await fixture.db.query<{ version_id: string }>(
      'SELECT version_id FROM flow_executions WHERE ticket_id=$1',
      [current.id],
    );
    // Nova versão ativada depois: o ticket adotado mantém a versão em que entrou.
    const general = (await flows.list(p.admin, p.id)).find((flow) => flow.template === 'general')!;
    const draft = await flows.get(p.admin, p.id, general.id);
    await flows.publish(p.admin, p.id, general.id, { expectedDraftVersion: draft.draftVersion });
    expect(
      (
        await fixture.db.query<{ version_id: string }>(
          'SELECT version_id FROM flow_executions WHERE ticket_id=$1',
          [current.id],
        )
      ).rows[0]!.version_id,
    ).toBe(bound.rows[0]!.version_id);
    expect((await adoption.plan(p.admin, p.id)).candidates).toEqual([]);
    expect(before.executionBindingsHash).not.toBe(
      (await adoption.inventory(p.admin, p.id)).executionBindingsHash,
    );
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_executions WHERE ticket_id=$1', [foreign.id]),
    ).toBe(0);
  });
});
