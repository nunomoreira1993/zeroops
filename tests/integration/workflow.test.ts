import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityService } from '../../packages/backend/src/modules/identity/identity.service.js';
import { TicketsService } from '../../packages/backend/src/modules/tickets/tickets.service.js';
import { WorkflowService } from '../../packages/backend/src/modules/workflow/workflow.service.js';
import { CandidateService } from '../../packages/backend/src/modules/executions/candidate.service.js';
import { unconfiguredCapabilities } from '../../packages/backend/src/capabilities.js';
import type { Role, User } from '../../packages/contracts/src/index.js';
import { startTestDatabase } from '../helpers/test-database.js';

describe('workflow real com MariaDB isolada', () => {
  let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
  let identity: IdentityService;
  let tickets: TicketsService;
  let workflow: WorkflowService;
  let admin: User;
  const users = new Map<Role, User>();
  const password = 'Fixture-only-strong-password-123!';

  beforeAll(async () => {
    fixture = await startTestDatabase();
    identity = new IdentityService(fixture.db);
    tickets = new TicketsService(fixture.db);
    workflow = new WorkflowService(fixture.db, unconfiguredCapabilities());
    await identity.createInitialAdmin({
      email: 'admin@example.test',
      displayName: 'Administrador de teste',
      password,
    });
    admin = (await identity.login('admin@example.test', password)).user;
    for (const role of ['client', 'technical', 'qa', 'release'] as const) {
      const { token } = await identity.invite(admin, {
        email: `${role}@example.test`,
        displayName: role,
        role,
      });
      users.set(role, (await identity.activate({ token, password, displayName: role })).user);
    }
  });
  afterAll(async () => {
    if (fixture) await fixture.stop();
  });
  function actor(role: Role) {
    const user = users.get(role);
    if (!user) throw new Error('Fixture ausente.');
    return user;
  }
  async function proposed() {
    const created = await tickets.create(actor('client'), {
      title: 'Erro de fixture no formulario',
      description: 'Reproduzir apenas no ambiente isolado de teste.',
      category: 'bug',
      environment: 'quality',
      priority: 'medium',
    });
    await tickets.assign(admin, created.id, {
      expectedVersion: created.version,
      clientUserId: actor('client').id,
      technicalUserId: actor('technical').id,
      qaUserId: actor('qa').id,
      releaseUserId: actor('release').id,
    });
    const ticket = await tickets.get(actor('client'), created.id);
    const proposal = await workflow.publishProposal(admin, ticket.id, {
      expectedVersion: ticket.version,
      summary: 'Corrigir validacao do formulario de teste.',
      steps: ['Reproduzir a falha', 'Corrigir validacao'],
      acceptanceCriteria: ['Caso invalido e rejeitado'],
      risks: [],
    });
    if (!proposal) throw new Error('Proposta nao gravada.');
    return { ticket: await tickets.get(actor('client'), ticket.id), proposal };
  }
  it('bloqueia a proposta quando os quatro responsáveis ainda não foram atribuídos', async () => {
    const ticket = await tickets.create(actor('client'), {
      title: 'Erro de fixture no formulario',
      description: 'Reproduzir apenas no ambiente isolado de teste.',
      category: 'bug',
      environment: 'quality',
      priority: 'medium',
    });
    await expect(
      workflow.publishProposal(actor('technical'), ticket.id, {
        expectedVersion: ticket.version,
        summary: 'Corrigir validacao do formulario de teste.',
        steps: ['Reproduzir a falha'],
        acceptanceCriteria: ['Caso invalido e rejeitado'],
        risks: [],
      }),
    ).rejects.toThrow('quatro responsáveis');
    expect((await tickets.get(actor('client'), ticket.id)).version).toBe(ticket.version);
  });
  it('duplo clique nao duplica aprovacao; executor indisponivel nao consome autorizacao', async () => {
    const { ticket, proposal } = await proposed();
    const input = {
      expectedVersion: ticket.version,
      artifactHash: proposal.hash,
      decision: 'approve',
      notes: '',
    };
    await expect(workflow.decide(actor('technical'), ticket.id, input)).rejects.toThrow(
      'responsável ativo atribuído',
    );
    const results = await Promise.allSettled([
      workflow.decide(actor('client'), ticket.id, input),
      workflow.decide(actor('client'), ticket.id, input),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const current = await tickets.get(actor('technical'), ticket.id);
    expect(current.status).toBe('awaiting_technical');
    await expect(
      workflow.decide(actor('technical'), ticket.id, {
        ...input,
        expectedVersion: current.version,
      }),
    ).rejects.toThrow('Executor');
    expect((await tickets.get(actor('technical'), ticket.id)).version).toBe(current.version);
    expect(
      (
        await fixture.db.query<{ count: number }>(
          'SELECT count(*) AS count FROM approvals WHERE ticket_id=$1',
          [ticket.id],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
  it('impede o responsável técnico atribuído de publicar a proposta que terá de aprovar', async () => {
    const created = await tickets.create(actor('client'), {
      title: 'Erro de fixture no formulario',
      description: 'Reproduzir apenas no ambiente isolado de teste.',
      category: 'bug',
      environment: 'quality',
      priority: 'medium',
    });
    await tickets.assign(admin, created.id, {
      expectedVersion: created.version,
      clientUserId: actor('client').id,
      technicalUserId: actor('technical').id,
      qaUserId: actor('qa').id,
      releaseUserId: actor('release').id,
    });
    await expect(
      workflow.publishProposal(actor('technical'), created.id, {
        expectedVersion: created.version + 1,
        summary: 'Corrigir validacao do formulario de teste.',
        steps: ['Reproduzir a falha'],
        acceptanceCriteria: ['Caso invalido e rejeitado'],
        risks: [],
      }),
    ).rejects.toThrow('responsável técnico atribuído');
    expect((await tickets.get(actor('technical'), created.id)).status).toBe('new');
  });
  it('substituir proposta invalida o hash e exige nova aprovacao do cliente', async () => {
    const { ticket, proposal } = await proposed();
    await workflow.publishProposal(admin, ticket.id, {
      expectedVersion: ticket.version,
      summary: 'Nova proposta com contexto atualizado.',
      steps: ['Rever validacao'],
      acceptanceCriteria: ['Novo criterio'],
      risks: ['Rever dados de teste'],
    });
    const updated = await tickets.get(actor('client'), ticket.id);
    await expect(
      workflow.decide(actor('client'), ticket.id, {
        expectedVersion: updated.version,
        artifactHash: proposal.hash,
        decision: 'approve',
        notes: '',
      }),
    ).rejects.toThrow('mudou');
  });
  it('rever o conteudo devolve a aprovacao a analise e preserva a revisao anterior', async () => {
    const { ticket, proposal } = await proposed();
    const revised = await tickets.update(actor('technical'), ticket.id, {
      title: 'Erro de fixture no formulario revisto',
      description: 'Contexto atualizado no ambiente isolado de teste.',
      category: ticket.category,
      environment: ticket.environment,
      priority: ticket.priority,
      expectedVersion: ticket.version,
    });
    expect(revised).toMatchObject({ status: 'investigating', version: ticket.version + 1 });
    await expect(
      workflow.decide(actor('client'), ticket.id, {
        expectedVersion: revised.version,
        artifactHash: proposal.hash,
        decision: 'approve',
        notes: '',
      }),
    ).rejects.toThrow('Esta etapa');
    const revisions = await tickets.detail(actor('client'), ticket.id);
    expect(revisions.revisions.at(-1)).toMatchObject({
      actorName: actor('technical').displayName,
      before: { title: ticket.title },
      after: { title: 'Erro de fixture no formulario revisto' },
    });
  });
  it('candidato comprovado exige QA e release distintos, nunca vai direto a resolvido', async () => {
    const enabledFixture = new WorkflowService(fixture.db, {
      investigation: true,
      implementation: true,
      deployment: true,
      blockers: [],
    });
    const { ticket, proposal } = await proposed();
    await enabledFixture.decide(actor('client'), ticket.id, {
      expectedVersion: ticket.version,
      artifactHash: proposal.hash,
      decision: 'approve',
      notes: '',
    });
    const technical = await tickets.get(actor('technical'), ticket.id);
    await enabledFixture.decide(actor('technical'), ticket.id, {
      expectedVersion: technical.version,
      artifactHash: proposal.hash,
      decision: 'approve',
      notes: '',
    });
    const run = (
      await fixture.db.query<{ id: string }>('SELECT id FROM execution_runs WHERE ticket_id=$1', [
        ticket.id,
      ])
    ).rows[0];
    if (!run) throw new Error('Run nao criado.');
    await fixture.db.query("UPDATE execution_runs SET status='running' WHERE id=$1", [run.id]);
    const manifest = {
      svnRevision: '42',
      files: [{ path: 'fixture.php', sha256: 'a'.repeat(64) }],
      tests: [{ command: 'fixture-test', exitCode: 0, evidenceHash: 'b'.repeat(64) }],
      sqlFiles: [],
    };
    const candidate = await new CandidateService(fixture.db).recordVerifiedCandidate(
      run.id,
      manifest,
    );
    const qa = await tickets.get(actor('qa'), ticket.id);
    expect(qa.status).toBe('awaiting_qa');
    await expect(
      enabledFixture.decide(actor('technical'), ticket.id, {
        expectedVersion: qa.version,
        artifactHash: candidate.hash,
        decision: 'approve',
        notes: '',
      }),
    ).rejects.toThrow('responsável ativo atribuído');
    await enabledFixture.decide(actor('qa'), ticket.id, {
      expectedVersion: qa.version,
      artifactHash: candidate.hash,
      decision: 'approve',
      notes: 'Validado em fixture.',
    });
    const release = await tickets.get(actor('release'), ticket.id);
    expect(release.status).toBe('awaiting_release');
    await expect(
      workflow.decide(actor('release'), ticket.id, {
        expectedVersion: release.version,
        artifactHash: candidate.hash,
        decision: 'approve',
        notes: '',
      }),
    ).rejects.toThrow('Destino');
    expect((await tickets.get(actor('release'), ticket.id)).status).toBe('awaiting_release');
  });
});
