import { useEffect, useState } from 'react';
import type {
  CapabilityCategory,
  CapabilityDevelopmentListView,
  CapabilityDevelopmentState,
  CapabilityDevelopmentView,
  CapabilitySettingsView,
  FlowCapabilityRequestView,
  FlowSummary,
  GitRepositoryView,
  ProjectPipelineView,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectAdmin, useProjectSession } from '../../lib/project-admin';

type T = (pt: string, en: string) => string;

const ACTIVE: CapabilityDevelopmentState[] = [
  'requested',
  'developing',
  'review',
  'publishing',
  'published',
];

export function capabilityStateLabel(state: CapabilityDevelopmentState, t: T) {
  const labels: Record<CapabilityDevelopmentState, string> = {
    requested: t('Pedida', 'Requested'),
    developing: t('Em desenvolvimento', 'In development'),
    review: t('Em revisão', 'In review'),
    publishing: t('Em publicação', 'Publishing'),
    published: t('Publicada (a confirmar)', 'Published (confirming)'),
    available: t('Disponível', 'Available'),
    linked: t('Associada ao rascunho', 'Linked to draft'),
    cancelled: t('Cancelada', 'Cancelled'),
    failed: t('Falhou', 'Failed'),
    reconciliation_required: t('Requer reconciliação', 'Needs reconciliation'),
  };
  return labels[state];
}

function categoryLabel(category: CapabilityCategory, t: T) {
  switch (category) {
    case 'configuration':
      return t('Configurar capacidade existente', 'Configure existing capability');
    case 'agent_skill':
      return t('Criar agente ou skill', 'Create agent or skill');
    case 'integration':
      return t('Desenvolver ferramenta/integração', 'Develop tool/integration');
    case 'zeroops_change':
      return t(
        'Alterar motor, interface ou runtime do ZeroOps',
        'Change ZeroOps engine, UI or runtime',
      );
  }
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : '—');

/**
 * Pedidos de capacidade em falta (P06) ligados ao processo executável de P10: proposta, ticket de
 * desenvolvimento, review, publicação pelo operador de rollout e associação auditada ao rascunho.
 * O estado vem do backend (eventos persistidos): recarregar a página retoma o acompanhamento.
 */
export function CapabilityDevelopmentPanel({
  flowId,
  draftVersion,
  requests,
  onChanged,
}: {
  flowId: string;
  draftVersion: number;
  requests: FlowCapabilityRequestView[];
  onChanged: () => void;
}) {
  const { t } = useIdentityLocale();
  const projectId = useProjectAdmin()?.project.id ?? '';
  const path = `/projects/${encodeURIComponent(projectId)}/flows/${encodeURIComponent(flowId)}/capability-developments`;
  const [refresh, setRefresh] = useState(0);
  const resource = useResource<CapabilityDevelopmentListView>(projectId ? path : null, refresh);
  const list = resource.data;
  const developments = list?.developments ?? [];
  const active = developments.some((item) => ACTIVE.includes(item.state));
  useEffect(() => setRefresh(active ? 10000 : 0), [active]);
  const open = requests.filter(
    (item) =>
      item.status === 'open' && !developments.some((dev) => dev.capabilityRequestId === item.id),
  );
  if (!open.length && !developments.length) return null;
  const reload = () => {
    resource.reload();
    onChanged();
  };
  return (
    <section className="stack" aria-label={t('Capacidades em falta', 'Missing capabilities')}>
      <h4>{t('Capacidades em falta', 'Missing capabilities')}</h4>
      <p className="muted">
        {t(
          'O fluxo depende destas capacidades. Pode pedir o desenvolvimento e continuar a editar o rascunho; a ativação fica bloqueada até a capacidade obrigatória estar disponível e associada. Publicar a capacidade não ativa o fluxo.',
          'The flow depends on these capabilities. You can request development and keep editing the draft; activation stays blocked until the required capability is available and linked. Publishing the capability does not activate the flow.',
        )}
      </p>
      {resource.error && <Notice>{resource.error}</Notice>}
      {list && list.settings.issues.length > 0 && (
        <Notice tone="warning">
          {t('Recursos de desenvolvimento do projeto:', 'Project development resources:')}{' '}
          {list.settings.issues.join(' ')}
        </Notice>
      )}
      {open.map((item) => (
        <CapabilityRequestCard
          key={item.id}
          path={path}
          item={item}
          can={list?.can ?? { develop: false, publish: false }}
          onStarted={reload}
        />
      ))}
      {developments.map((item) => (
        <CapabilityDevelopmentCard
          key={`${item.id}:${item.version}`}
          path={path}
          item={item}
          draftVersion={draftVersion}
          onChanged={reload}
        />
      ))}
    </section>
  );
}

function CapabilityRequestCard({
  path,
  item,
  can,
  onStarted,
}: {
  path: string;
  item: FlowCapabilityRequestView;
  can: { develop: boolean; publish: boolean };
  onStarted: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  const mutation = useMutation();
  const [form, setForm] = useState({
    category: (item.kind === 'agent' || item.kind === 'skill'
      ? 'agent_skill'
      : 'integration') as CapabilityCategory,
    title: item.capability.slice(0, 180),
    requirement: item.reason,
    criteria: '',
    required: true,
    authorizePublish: false,
  });
  const criteria = form.criteria
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 3);
  return (
    <article className="panel stack">
      <p>
        <strong>{item.capability}</strong> ({item.kind}){item.nodeId ? ` · ${item.nodeId}` : ''} —{' '}
        {item.reason}
      </p>
      {can.develop ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(async () => {
              await request(path, {
                method: 'POST',
                body: {
                  capabilityRequestId: item.id,
                  category: form.category,
                  title: form.title.trim(),
                  requirement: form.requirement.trim(),
                  acceptanceCriteria: criteria,
                  required: form.required,
                  authorizePublish: form.authorizePublish,
                },
              });
              onStarted();
            });
          }}
        >
          <label>
            {t('Tipo', 'Type')}
            <select
              value={form.category}
              onChange={(event) =>
                setForm({ ...form, category: event.target.value as CapabilityCategory })
              }
            >
              {(['configuration', 'agent_skill', 'integration', 'zeroops_change'] as const).map(
                (category) => (
                  <option key={category} value={category}>
                    {categoryLabel(category, t)}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            {t('Título', 'Title')}
            <input
              value={form.title}
              maxLength={180}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </label>
          <label>
            {t('Requisito', 'Requirement')}
            <textarea
              rows={3}
              maxLength={8000}
              value={form.requirement}
              onChange={(event) => setForm({ ...form, requirement: event.target.value })}
            />
          </label>
          <label>
            {t('Critérios de aceitação (um por linha)', 'Acceptance criteria (one per line)')}
            <textarea
              rows={3}
              value={form.criteria}
              onChange={(event) => setForm({ ...form, criteria: event.target.value })}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.required}
              onChange={(event) => setForm({ ...form, required: event.target.checked })}
            />
            {t('Obrigatória para ativar o fluxo', 'Required to activate the flow')}
          </label>
          {can.publish && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.authorizePublish}
                onChange={(event) => setForm({ ...form, authorizePublish: event.target.checked })}
              />
              {t(
                'Autorizar já a publicação (após testes e review)',
                'Authorize publication now (after tests and review)',
              )}
            </label>
          )}
          {mutation.error && <Notice>{mutation.error}</Notice>}
          <button
            className="button button-primary align-start"
            disabled={
              mutation.busy ||
              form.title.trim().length < 5 ||
              form.requirement.trim().length < 10 ||
              !criteria.length
            }
          >
            {t('Pedir desenvolvimento', 'Request development')}
          </button>
        </form>
      ) : (
        <p className="muted">
          {t(
            'Sem permissão para iniciar o desenvolvimento de capacidades neste projeto.',
            'No permission to start capability development in this project.',
          )}
        </p>
      )}
    </article>
  );
}

function CapabilityDevelopmentCard({
  path,
  item,
  draftVersion,
  onChanged,
}: {
  path: string;
  item: CapabilityDevelopmentView;
  draftVersion: number;
  onChanged: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  const mutation = useMutation();
  const [acknowledge, setAcknowledge] = useState(false);
  const action = (name: string, body: Record<string, unknown>) =>
    mutation.run(async () => {
      await request(`${path}/${encodeURIComponent(item.id)}/${name}`, { method: 'POST', body });
      onChanged();
    });
  const dev = item.development;
  return (
    <article className="panel stack" aria-label={item.title}>
      <p>
        <strong>{item.title}</strong>{' '}
        <span className="flow-chip">{capabilityStateLabel(item.state, t)}</span>{' '}
        <span className="muted">{categoryLabel(item.category, t)}</span>
      </p>
      <p>{item.nextStep}</p>
      {item.stateReason && <p className="muted">{item.stateReason}</p>}
      <dl className="flow-capability-facts">
        {item.ticket && (
          <>
            <dt>{t('Ticket', 'Ticket')}</dt>
            <dd>
              <a href={`#/tickets/${encodeURIComponent(item.ticket.id)}`}>{item.ticket.key}</a> (
              {item.ticket.status})
            </dd>
          </>
        )}
        {dev && (
          <>
            <dt>{t('Branch', 'Branch')}</dt>
            <dd>
              {dev.branch ?? '—'} · {t('base', 'base')} {short(dev.baseSha)} → {short(dev.headSha)}
            </dd>
            <dt>{t('Testes', 'Tests')}</dt>
            <dd>
              {dev.testsPassed === null
                ? t('ainda não executados', 'not run yet')
                : dev.testsPassed
                  ? t('passaram', 'passed')
                  : t('falharam', 'failed')}
            </dd>
            <dt>PR</dt>
            <dd>
              {dev.pullRequestUrl ? (
                <a href={dev.pullRequestUrl} target="_blank" rel="noreferrer">
                  {dev.pullRequestUrl}
                </a>
              ) : (
                '—'
              )}
              {dev.reviewPending ? ` · ${t('review pendente', 'review pending')}` : ''}
            </dd>
          </>
        )}
        {item.delivery && (
          <>
            <dt>{t('Publicação', 'Publication')}</dt>
            <dd>
              {item.delivery.state} · {short(item.delivery.integratedSha)}
              {item.delivery.stateReason ? ` — ${item.delivery.stateReason}` : ''}
            </dd>
          </>
        )}
        <dt>{t('Autorização de publicação', 'Publish authorization')}</dt>
        <dd>
          {item.publishAuthorizedBy
            ? `${item.publishAuthorizedBy} (${item.publishAuthorizedAt ?? ''})`
            : t('pendente', 'pending')}
        </dd>
        {(item.runtimeVersion || item.publishedSha) && (
          <>
            <dt>{t('Disponibilidade', 'Availability')}</dt>
            <dd>
              {t('publicado', 'published')} {short(item.publishedSha)} ·{' '}
              {t('versão ativa', 'active version')} {short(item.runtimeVersion)}
              {item.runtimeConfirmedAt
                ? ` · ${t('confirmada em', 'confirmed at')} ${item.runtimeConfirmedAt}`
                : ''}
            </dd>
          </>
        )}
        {item.linkedDraftVersion && (
          <>
            <dt>{t('Rascunho', 'Draft')}</dt>
            <dd>
              {t('associada na revisão', 'linked at revision')} {item.linkedDraftVersion} (
              {t('o fluxo continua por ativar', 'the flow is still not activated')})
            </dd>
          </>
        )}
      </dl>
      {item.draftChanged && item.can.link && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={acknowledge}
            onChange={(event) => setAcknowledge(event.target.checked)}
          />
          {t(
            `O rascunho mudou desde o pedido (rev. ${item.sourceDraftVersion}). Confirmo que esta capacidade continua aplicável.`,
            `The draft changed since the request (rev. ${item.sourceDraftVersion}). I confirm this capability still applies.`,
          )}
        </label>
      )}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <div className="flow-checks">
        {item.can.authorizePublish && (
          <button
            className="button"
            disabled={mutation.busy}
            onClick={() => void action('authorize-publish', { expectedVersion: item.version })}
          >
            {t('Autorizar publicação', 'Authorize publication')}
          </button>
        )}
        {item.can.link && (
          <button
            className="button button-primary"
            disabled={mutation.busy || (item.draftChanged && !acknowledge)}
            onClick={() =>
              void action('link', {
                expectedVersion: item.version,
                expectedDraftVersion: draftVersion,
                acknowledgeDraftChanged: acknowledge,
              })
            }
          >
            {t('Associar ao rascunho', 'Link to draft')}
          </button>
        )}
        {item.can.cancel && (
          <button
            className="button"
            disabled={mutation.busy}
            onClick={() => void action('cancel', { expectedVersion: item.version })}
          >
            {t('Cancelar pedido', 'Cancel request')}
          </button>
        )}
      </div>
      {item.events.length > 0 && (
        <details>
          <summary>{t('Histórico', 'History')}</summary>
          <ol className="flow-capability-history">
            {item.events.slice(0, 15).map((event) => (
              <li key={event.id}>
                {event.createdAt} · {event.kind}
                {event.actor ? ` · ${event.actor}` : ''}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

/**
 * Recursos atribuídos ao projeto para desenvolver/publicar capacidades (P10): repositório do ZeroOps,
 * pipeline de rollout e fluxo de desenvolvimento. Só quem gere repositórios do projeto altera.
 */
export function CapabilitySettingsCard({
  projectId,
  pipelines,
  repositories,
}: {
  projectId: string;
  pipelines: ProjectPipelineView[];
  repositories: GitRepositoryView[];
}) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  const path = `/projects/${encodeURIComponent(projectId)}/capabilities/settings`;
  const settings = useResource<CapabilitySettingsView>(path);
  const flows = useResource<FlowSummary[]>(`/project-admin/${encodeURIComponent(projectId)}/flows`);
  const mutation = useMutation();
  const [form, setForm] = useState<{
    repositoryId: string;
    pipelineId: string;
    developmentFlowId: string;
  } | null>(null);
  const current = settings.data;
  if (!current) return null;
  const value = form ?? {
    repositoryId: current.repositoryId ?? '',
    pipelineId: current.pipelineId ?? '',
    developmentFlowId: current.developmentFlowId ?? '',
  };
  const candidates = pipelines.filter((pipeline) => pipeline.repository.id === value.repositoryId);
  return (
    <section
      className="panel stack"
      aria-label={t('Capacidades do ZeroOps', 'ZeroOps capabilities')}
    >
      <h3>{t('Desenvolvimento de capacidades', 'Capability development')}</h3>
      <p className="muted">
        {t(
          'Repositório, pipeline de rollout e fluxo usados quando a autoria pede uma capacidade em falta. Desenvolver e publicar exigem permissões separadas; publicar uma capacidade nunca ativa fluxos.',
          'Repository, rollout pipeline and flow used when authoring requests a missing capability. Developing and publishing require separate permissions; publishing a capability never activates flows.',
        )}
      </p>
      {current.issues.length > 0 && <Notice tone="warning">{current.issues.join(' ')}</Notice>}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void mutation.run(async () => {
            await request(path, {
              method: 'POST',
              body: { ...value, expectedVersion: current.version },
            });
            setForm(null);
            settings.reload();
          });
        }}
      >
        <fieldset className="flow-fieldset" disabled={!current.canManage || mutation.busy}>
          <label>
            {t('Repositório', 'Repository')}
            <select
              value={value.repositoryId}
              onChange={(event) =>
                setForm({ ...value, repositoryId: event.target.value, pipelineId: '' })
              }
            >
              <option value="">—</option>
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Pipeline de rollout', 'Rollout pipeline')}
            <select
              value={value.pipelineId}
              onChange={(event) => setForm({ ...value, pipelineId: event.target.value })}
            >
              <option value="">—</option>
              {candidates.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name} ({pipeline.environment})
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Fluxo de desenvolvimento', 'Development flow')}
            <select
              value={value.developmentFlowId}
              onChange={(event) => setForm({ ...value, developmentFlowId: event.target.value })}
            >
              <option value="">—</option>
              {(flows.data ?? []).map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.name}
                </option>
              ))}
            </select>
          </label>
          {mutation.error && <Notice>{mutation.error}</Notice>}
          <button
            className="button button-primary align-start"
            disabled={!value.repositoryId || !value.pipelineId || !value.developmentFlowId}
          >
            {t('Gravar', 'Save')}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
