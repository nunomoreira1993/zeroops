import { useState } from 'react';
import type { AgentInstructions, ProductionRelayStatus } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale, useIdentityMutation } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';

const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Instruções do projeto para o agente: texto versionado incluído no prompt de cada run. */
function InstructionsEditor() {
  const { request } = useProjectSession();
  const { t } = useIdentityLocale();
  const resource = useResource<AgentInstructions>('/agent/instructions');
  const mutation = useIdentityMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (resource.loading) return <Loading />;
  if (resource.error) return <ResourceError error={resource.error} retry={resource.reload} />;
  const data = resource.data;
  if (!data) return null;
  const body = draft ?? data.body;
  const save = () =>
    mutation.run(async () => {
      setMessage(null);
      await request('/agent/instructions', {
        method: 'POST',
        body: { body, expectedVersion: data.version },
      });
      setDraft(null);
      setMessage(t('Instruções gravadas. Aplicam-se aos próximos runs.', 'Instructions saved.'));
      resource.reload();
    });

  return (
    <div className="agent-settings-block">
      <div className="agent-settings-block-head">
        <h3>{t('Instruções do agente', 'Agent instructions')}</h3>
        <span className="muted">
          {data.isDefault
            ? t('Texto por omissão (ainda não gravado)', 'Default text (not saved yet)')
            : t(
                `Versão ${data.version} · ${data.updatedBy ?? '—'} · ${dateTime(data.updatedAt)}`,
                `Version ${data.version} · ${data.updatedBy ?? '—'} · ${dateTime(data.updatedAt)}`,
              )}
        </span>
      </div>
      <p className="muted">
        {t(
          'Incluídas no prompt de cada investigação: onde estão os dados reais, que tabelas e logs consultar e como responder. Cada gravação cria uma nova versão auditada.',
          'Included in every investigation prompt. Each save creates a new audited version.',
        )}
      </p>
      {message && <Notice tone="success">{message}</Notice>}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <textarea
        className="agent-instructions-text"
        value={body}
        readOnly={!data.canManage}
        rows={18}
        maxLength={20000}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={t('Instruções do agente', 'Agent instructions')}
      />
      {data.canManage && (
        <div className="integration-actions">
          <button
            className="button button-primary"
            disabled={mutation.busy || draft === null || body.trim().length < 20}
            onClick={() => void save()}
          >
            {t('Gravar nova versão', 'Save new version')}
          </button>
          {draft !== null && (
            <button className="button button-secondary" onClick={() => setDraft(null)}>
              {t('Descartar alterações', 'Discard changes')}
            </button>
          )}
        </div>
      )}
      {data.history.length > 1 && (
        <details className="agent-settings-history">
          <summary>{t('Histórico de versões', 'Version history')}</summary>
          <ul>
            {data.history.map((item) => (
              <li key={item.version}>
                v{item.version} · {item.author ?? '—'} · {dateTime(item.createdAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Automatismos do agente: investigação automática de pedidos novos e perguntas ao cliente. */
function ClientChannelSettings() {
  const { request } = useProjectSession();
  const { t } = useIdentityLocale();
  const resource = useResource<AgentInstructions>('/agent/instructions');
  const mutation = useIdentityMutation();
  const [message, setMessage] = useState<string | null>(null);

  if (resource.loading) return <Loading />;
  if (resource.error) return <ResourceError error={resource.error} retry={resource.reload} />;
  const data = resource.data;
  if (!data) return null;
  const toggle = (body: { autoClientQuestions?: boolean; autoInvestigate?: boolean }) =>
    mutation.run(async () => {
      setMessage(null);
      await request('/agent/settings', { method: 'POST', body });
      setMessage(t('Preferência gravada.', 'Preference saved.'));
      resource.reload();
    });

  return (
    <div className="agent-settings-block">
      <div className="agent-settings-block-head">
        <h3>{t('Automatismos', 'Automation')}</h3>
      </div>
      <p className="muted">
        {t(
          'O cliente só vê a resposta final (revista pela equipa) e as perguntas do agente. Quando responde, o Copilot volta a investigar automaticamente.',
          'The client only sees the reviewed final answer and the agent questions.',
        )}
      </p>
      {message && <Notice tone="success">{message}</Notice>}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <label className="agent-settings-toggle">
        <input
          type="checkbox"
          checked={data.autoInvestigate}
          disabled={!data.canManage || mutation.busy}
          onChange={(event) => void toggle({ autoInvestigate: event.target.checked })}
        />
        <span>
          {t(
            'Investigar automaticamente cada pedido novo com o Copilot',
            'Investigate every new request with Copilot automatically',
          )}
          <small className="muted">
            {t(
              'Inclui os incidentes da Saúde. Desligado: a equipa pede a investigação no pedido.',
              'Includes health incidents. Off: the team requests the investigation.',
            )}
          </small>
        </span>
      </label>
      <label className="agent-settings-toggle">
        <input
          type="checkbox"
          checked={data.autoClientQuestions}
          disabled={!data.canManage || mutation.busy}
          onChange={(event) => void toggle({ autoClientQuestions: event.target.checked })}
        />
        <span>
          {t(
            'Enviar perguntas ao cliente automaticamente',
            'Send questions to the client automatically',
          )}
          <small className="muted">
            {t(
              'Desligado: as perguntas ficam na nota interna para a equipa as enviar.',
              'Off: questions stay in the internal note for the team.',
            )}
          </small>
        </span>
      </label>
    </div>
  );
}

/** Estado do relay instalado em Produção e geração do token (mostrado uma única vez). */
function RelayStatusPanel() {
  const { request } = useProjectSession();
  const { t } = useIdentityLocale();
  const resource = useResource<ProductionRelayStatus>('/agent/relay');
  const mutation = useIdentityMutation();
  const [token, setToken] = useState<string | null>(null);

  if (resource.loading) return <Loading />;
  if (resource.error) return <ResourceError error={resource.error} retry={resource.reload} />;
  const relay = resource.data;
  if (!relay) return null;
  const rotate = () => {
    const confirmText = relay.configured
      ? t(
          'Gerar um novo token? O relay em Produção deixa de funcionar até ser atualizado com o novo token.',
          'Generate a new token? The production relay stops until updated.',
        )
      : t('Gerar o token do relay de Produção?', 'Generate the production relay token?');
    if (!window.confirm(confirmText)) return;
    void mutation.run(async () => {
      const result = await request<{ token: string }>('/agent/relay/token', { method: 'POST' });
      setToken(result.token);
      resource.reload();
    });
  };

  return (
    <div className="agent-settings-block">
      <div className="agent-settings-block-head">
        <h3>{t('Ligação a Produção (relay)', 'Production relay')}</h3>
        <span
          className={`status-badge ${relay.online ? 'status-resolved' : relay.configured ? 'status-blocked' : 'status-cancelled'}`}
        >
          <span />
          {relay.online
            ? t('Ligado', 'Online')
            : relay.configured
              ? t('Desligado', 'Offline')
              : t('Por configurar', 'Not configured')}
        </span>
      </div>
      <p className="muted">
        {t(
          'O relay corre no servidor de Produção e vem buscar as consultas do agente (SQL só de leitura com o utilizador zeroops_agent e logs da aplicação). Sem relay ligado, o agente só tem acesso a QA e indica-o na resposta.',
          'The relay runs on the production server and fetches the agent read-only queries.',
        )}
      </p>
      <dl className="integration-meta">
        <div>
          <dt>{t('Servidor', 'Host')}</dt>
          <dd>{relay.hostname ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('Versão', 'Version')}</dt>
          <dd>{relay.version ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('Último contacto', 'Last seen')}</dt>
          <dd>{dateTime(relay.lastSeenAt)}</dd>
        </div>
        <div>
          <dt>{t('Últimas 24 h', 'Last 24 h')}</dt>
          <dd>
            {relay.lastDay.done} ok · {relay.lastDay.failed} {t('falhas', 'failed')} ·{' '}
            {relay.lastDay.expired} {t('expiradas', 'expired')}
            {relay.pending ? ` · ${relay.pending} ${t('em curso', 'in progress')}` : ''}
          </dd>
        </div>
      </dl>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {token && (
        <div className="agent-relay-token">
          <Notice tone="info">
            {t(
              'Copie agora: o token não volta a ser mostrado. Grave-o em /etc/zeroops-relay/token.env (ZEROOPS_RELAY_TOKEN=...) no servidor de Produção e reinicie o serviço zeroops-relay.',
              'Copy it now: it is not shown again.',
            )}
          </Notice>
          <code>{token}</code>
          <button
            className="button button-secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(token);
            }}
          >
            <Icon name="check" size={16} /> {t('Copiar', 'Copy')}
          </button>
        </div>
      )}
      <div className="integration-actions">
        <button className="button button-secondary" onClick={resource.reload}>
          <Icon name="refresh" size={16} /> {t('Atualizar estado', 'Refresh')}
        </button>
        {relay.canManage && (
          <button className="button button-primary" disabled={mutation.busy} onClick={rotate}>
            {relay.configured
              ? t('Gerar novo token', 'Rotate token')
              : t('Gerar token', 'Generate token')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Configuração do agente de investigação, visível só para a equipa (não para clientes). */
export function AgentSettingsPanel() {
  const { session } = useProjectSession();
  const { t } = useIdentityLocale();
  if (!session || (session.user.role === 'client' && !session.user.instanceAdmin)) return null;
  return (
    <section className="panel integration-settings agent-settings">
      <header className="integration-settings-head">
        <div>
          <h2>{t('Agente de investigação', 'Investigation agent')}</h2>
          <p className="muted">
            {t(
              'Onde o agente procura os dados: Produção para casos reais, QA para testes e validação de código.',
              'Where the agent looks for data: production for real cases, QA for tests.',
            )}
          </p>
        </div>
      </header>
      <RelayStatusPanel />
      <ClientChannelSettings />
      <InstructionsEditor />
    </section>
  );
}
