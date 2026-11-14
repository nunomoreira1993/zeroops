import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { AgentRunsService } from './agent-runs.service.js';
import { AgentModelsService } from './agent-models.service.js';
import { resumeAfterClientReply } from './agent-client-channel.js';
import { autoInvestigateNewTicket } from './agent-auto-runs.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let runs: AgentRunsService;
let tickets: TicketsService;
beforeAll(async () => {
  fixture = await startTestDatabase();
  runs = new AgentRunsService(fixture.db);
  tickets = new TicketsService(fixture.db, [resumeAfterClientReply]);
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(role: Role, projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects (id,name) VALUES ($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, 'Agent test'],
  );
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: `Test ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

async function scenario() {
  const client = await member('client');
  const technical = await member('technical', client.projectId);
  const ticket = await tickets.create(client, {
    title: 'Pedido para investigar',
    description: 'O cliente pede a análise de uma situação.',
    category: 'question',
    environment: 'production',
    priority: 'medium',
  });
  await tickets.comment(client, ticket.id, { body: 'Informação adicional.', visibility: 'public' });
  return { client, technical, ticket };
}

describe('AgentRunsService', () => {
  it('recarrega tiers se o executor antigo atualizar a cache depois da migração', async () => {
    const { technical } = await scenario();
    await fixture.db.query(
      `INSERT INTO agent_model_catalogs(project_id,refresh_requested_at,refreshed_at)
       VALUES($1,NOW(3)-INTERVAL 1 MINUTE,NOW(3))`,
      [technical.projectId],
    );
    const models = new AgentModelsService(fixture.db);
    expect(await models.claimRefresh()).toBe(technical.projectId);
    await models.save(technical.projectId, [], null, []);
    expect(await models.claimRefresh()).toBeNull();
  });

  it('valida e persiste Fusion e recusa o mesmo tier no perfil Local', async () => {
    const { technical, ticket } = await scenario();
    await fixture.db.query('INSERT INTO agent_model_catalogs(project_id) VALUES($1)', [
      technical.projectId,
    ]);
    const catalog = new AgentModelsService(fixture.db);
    await catalog.save(technical.projectId, [], null, [
      {
        id: 'server-route-standard',
        name: 'Fusion Standard',
        description: '',
        fusionTier: 'standard',
        enabled: true,
        visible: true,
        reason: null,
      },
    ]);
    await expect(
      runs.request(technical, ticket.id, {
        executionMode: 'local',
        model: 'fusion',
        fusionTier: 'standard',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_MODEL_INVALID' });
    await expect(
      runs.request(technical, ticket.id, {
        executionMode: 'copilot',
        model: 'fusion',
        fusionTier: 'max',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_MODEL_INVALID' });
    const run = await runs.request(technical, ticket.id, {
      executionMode: 'copilot',
      model: 'fusion',
      fusionTier: 'standard',
    });
    expect(run).toMatchObject({
      model: 'fusion',
      executionMode: 'copilot',
      fusionTier: 'standard',
      reasoningEffort: null,
    });
    expect((await runs.list(technical, ticket.id))[0]).toMatchObject({
      model: 'fusion',
      executionMode: 'copilot',
      fusionTier: 'standard',
    });
  });
  it('reserva a investigação à equipa e permite um único run ativo por pedido', async () => {
    const { client, technical, ticket } = await scenario();
    await expect(runs.request(client, ticket.id, {})).rejects.toMatchObject({ status: 403 });
    const run = await runs.request(technical, ticket.id, { instructions: 'Ver pagamentos.' });
    expect(run).toMatchObject({ status: 'queued', instructions: 'Ver pagamentos.' });
    await expect(runs.request(technical, ticket.id, {})).rejects.toMatchObject({
      code: 'AGENT_RUN_ACTIVE',
    });
    await expect(runs.list(client, ticket.id)).rejects.toMatchObject({ status: 403 });
    expect(await runs.cancel(technical, ticket.id, run.id)).toMatchObject({ status: 'cancelled' });
    expect((await runs.request(technical, ticket.id, {})).status).toBe('queued');
  });

  it('entrega o contexto, guarda o rascunho e publica só uma nota interna do agente', async () => {
    const { client, technical, ticket } = await scenario();
    await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE status='queued'");
    const run = await runs.request(technical, ticket.id, {});
    const context = await runs.claimNext();
    expect(context?.runId).toBe(run.id);
    expect(context?.ticket.key).toBe(ticket.key);
    expect(context?.conversation.map((message) => message.body)).toContain('Informação adicional.');
    await runs.reportProgress(run.id, 'A consultar');
    await runs.complete(run.id, {
      summary: 'Encomenda confirmada.',
      replyDraft: 'Bom dia, confirmámos a encomenda.',
      evidence: [{ source: 'BD do site', detail: 'Encomenda paga.' }],
    });
    const [done] = await runs.list(technical, ticket.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      replyDraft: 'Bom dia, confirmámos a encomenda.',
      evidence: [{ source: 'BD do site', detail: 'Encomenda paga.' }],
    });
    const notes = await fixture.db.query<{ visibility: string; author_kind: string; body: string }>(
      'SELECT visibility,author_kind,body FROM ticket_comments WHERE ticket_id=$1 AND automated',
      [ticket.id],
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({ visibility: 'internal', author_kind: 'agent' });
    const visible = await tickets.detail(client, ticket.id);
    expect(JSON.stringify(visible)).not.toContain('Encomenda confirmada.');
  });

  it('converte cancelamento pedido durante a execução e falhas em estados finais', async () => {
    const { technical, ticket } = await scenario();
    await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE status='queued'");
    const run = await runs.request(technical, ticket.id, {});
    await runs.claimNext();
    expect(await runs.cancel(technical, ticket.id, run.id)).toMatchObject({
      status: 'running',
      cancelRequested: true,
    });
    expect(await runs.isCancelRequested(run.id)).toBe(true);
    await runs.fail(run.id, 'cancelled');
    expect((await runs.list(technical, ticket.id))[0]?.status).toBe('cancelled');
    const second = await runs.request(technical, ticket.id, {});
    await runs.claimNext();
    expect(await runs.failInterrupted()).toBe(1);
    const [last] = await runs.list(technical, ticket.id);
    expect(last).toMatchObject({
      id: second.id,
      status: 'failed',
      errorCode: 'executor_interrupted',
    });
  });

  it('valida o modelo contra o catálogo do projeto e liga a nota final ao run', async () => {
    const { client, technical, ticket } = await scenario();
    await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE status='queued'");
    const models = new AgentModelsService(fixture.db);
    await expect(models.catalog(client, ticket.id)).rejects.toMatchObject({ status: 403 });
    const first = await models.catalog(technical, ticket.id);
    expect(first).toMatchObject({ refreshing: true, models: [{ id: 'auto' }] });
    expect(await models.claimRefresh()).toBe(technical.projectId);
    await models.save(
      technical.projectId,
      [
        {
          id: 'gpt-5',
          name: 'GPT-5',
          multiplier: 1,
          efforts: ['high'],
          defaultEffort: null,
          fusion: false,
        },
      ],
      null,
    );
    expect((await models.catalog(technical, ticket.id)).models.map((m) => m.id)).toEqual([
      'auto',
      'gpt-5',
    ]);
    await expect(
      runs.request(technical, ticket.id, { model: 'desconhecido' }),
    ).rejects.toMatchObject({ code: 'AGENT_MODEL_INVALID' });
    await expect(
      runs.request(technical, ticket.id, { model: 'gpt-5', reasoningEffort: 'xhigh' }),
    ).rejects.toMatchObject({ code: 'AGENT_MODEL_INVALID' });
    const run = await runs.request(technical, ticket.id, {
      model: 'gpt-5',
      reasoningEffort: 'high',
    });
    expect(run).toMatchObject({ model: 'gpt-5', reasoningEffort: 'high' });
    const context = await runs.claimNext();
    expect(context).toMatchObject({ runId: run.id, model: 'gpt-5', reasoningEffort: 'high' });
    await runs.complete(run.id, { summary: 'Feito.', replyDraft: null, evidence: [] });
    const detail = await tickets.detail(technical, ticket.id);
    expect(detail.comments.find((comment) => comment.agentRunId === run.id)).toBeDefined();
  });

  describe('canal do cliente', () => {
    async function runWithQuestions(ticketId: string, questions: string[]) {
      const context = await runs.claimNext();
      expect(context).not.toBeNull();
      await runs.complete(context!.runId, {
        summary: 'Falta o número da encomenda.',
        replyDraft: null,
        evidence: [],
        clientQuestions: questions,
      });
      return (
        await fixture.db.query<{ status: string }>('SELECT status FROM tickets WHERE id=$1', [
          ticketId,
        ])
      ).rows[0]!;
    }

    it('envia as perguntas ao cliente e retoma a investigação quando ele responde', async () => {
      const { client, technical, ticket } = await scenario();
      await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE status='queued'");
      await runs.request(technical, ticket.id, {});
      const state = await runWithQuestions(ticket.id, ['Qual é o número da encomenda?']);
      expect(state.status).toBe('awaiting_information');
      const [done] = await runs.list(technical, ticket.id);
      expect(done).toMatchObject({
        trigger: 'manual',
        clientQuestions: ['Qual é o número da encomenda?'],
      });
      expect(done?.clientMessageId).toBeTruthy();
      const visible = await tickets.detail(client, ticket.id);
      const sent = visible.comments.find((comment) => comment.id === done?.clientMessageId);
      expect(sent).toMatchObject({ visibility: 'public', authorKind: 'agent' });
      expect(sent?.body).toContain('1. Qual é o número da encomenda?');
      expect(JSON.stringify(visible)).not.toContain('Falta o número da encomenda.');
      const outbox = await fixture.db.query<{ payload: { commentId: string } }>(
        "SELECT payload FROM notification_outbox WHERE topic='ticket.comment_created'",
      );
      expect(outbox.rows.some((row) => row.payload.commentId === done?.clientMessageId)).toBe(true);

      await tickets.comment(technical, ticket.id, { body: 'Nota.', visibility: 'internal' });
      expect(await runs.list(technical, ticket.id)).toHaveLength(1);
      await tickets.comment(client, ticket.id, { body: 'É a 12345.', visibility: 'public' });
      const [resumed] = await runs.list(technical, ticket.id);
      expect(resumed).toMatchObject({ status: 'queued', trigger: 'client_reply' });
      expect(resumed?.requestedBy.id).toBe(technical.id);
      expect((await tickets.detail(client, ticket.id)).ticket.status).toBe('investigating');
    });

    it('com o envio automático desligado as perguntas ficam só na nota interna', async () => {
      const { client, technical, ticket } = await scenario();
      await fixture.db.query('UPDATE projects SET agent_auto_client_questions=0 WHERE id=$1', [
        client.projectId,
      ]);
      await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE status='queued'");
      await runs.request(technical, ticket.id, {});
      const state = await runWithQuestions(ticket.id, ['Qual é a loja?']);
      expect(state.status).toBe('new');
      const [done] = await runs.list(technical, ticket.id);
      expect(done).toMatchObject({ clientQuestions: ['Qual é a loja?'], clientMessageId: null });
      const publicAgent = await fixture.db.query(
        "SELECT id FROM ticket_comments WHERE ticket_id=$1 AND automated AND visibility='public'",
        [ticket.id],
      );
      expect(publicAgent.rowCount).toBe(0);
    });

    it('pede revisão humana após 3 investigações automáticas seguidas', async () => {
      const { client, technical, ticket } = await scenario();
      await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE status='queued'");
      await runs.request(technical, ticket.id, {});
      await runWithQuestions(ticket.id, ['Pergunta 0?']);
      for (let round = 1; round <= 3; round++) {
        await tickets.comment(client, ticket.id, {
          body: `Resposta ${round}.`,
          visibility: 'public',
        });
        await runWithQuestions(ticket.id, [`Pergunta ${round}?`]);
      }
      await tickets.comment(client, ticket.id, { body: 'Resposta 4.', visibility: 'public' });
      const list = await runs.list(technical, ticket.id);
      expect(list).toHaveLength(4);
      expect(list.filter((run) => run.trigger === 'client_reply')).toHaveLength(3);
      expect(list.every((run) => run.status === 'succeeded')).toBe(true);
      const review = await fixture.db.query(
        "SELECT id FROM ticket_comments WHERE ticket_id=$1 AND visibility='internal' AND body LIKE '%Revisão necessária%'",
        [ticket.id],
      );
      expect(review.rowCount).toBe(1);
    });
  });

  it('investiga automaticamente os pedidos novos quando o Copilot está verificado e a opção ligada', async () => {
    const auto = new TicketsService(fixture.db, [], [autoInvestigateNewTicket]);
    const client = await member('client');
    const admin = await member('admin', client.projectId);
    const input = {
      title: 'Pedido com investigação automática',
      description: 'O cliente descreve um problema no site.',
      category: 'question' as const,
      environment: 'production' as const,
      priority: 'medium' as const,
    };
    const runsOf = async (ticketId: string) =>
      (
        await fixture.db.query<{ run_trigger: string; requested_by: string }>(
          'SELECT run_trigger,requested_by FROM agent_runs WHERE ticket_id=$1',
          [ticketId],
        )
      ).rows;
    expect(await runsOf((await auto.create(client, input)).id)).toEqual([]);
    await fixture.db.query(
      `INSERT INTO integration_settings
         (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
       VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
      [randomUUID(), client.projectId, admin.id],
    );
    // Pedido de um cliente: o run fica em nome da equipa.
    expect(await runsOf((await auto.create(client, input)).id)).toEqual([
      { run_trigger: 'auto', requested_by: admin.id },
    ]);
    await fixture.db.query('UPDATE projects SET agent_auto_investigate=0 WHERE id=$1', [
      client.projectId,
    ]);
    expect(await runsOf((await auto.create(client, input)).id)).toEqual([]);
  });
});
