import {
  copilotMode,
  deliveryNodeConfig,
  developmentNodeConfig,
  developmentPublishModes,
  flowReviewConfig,
  reviewRules,
  type FlowDefinition,
  type FlowDetail,
  type FlowNode,
  type GitRepositoryView,
  type ProjectPipelineView,
} from '@zeroops/contracts';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectAdmin } from '../../lib/project-admin';
import { useSession } from '../../lib/session';

const publishLabels = {
  none: {
    pt: 'Não publicar (só commit no workspace)',
    en: 'Do not publish (workspace commit only)',
  },
  branch: { pt: 'Publicar a branch', en: 'Publish the branch' },
  pull_request: { pt: 'Publicar a branch e abrir PR', en: 'Publish the branch and open a PR' },
};
const ruleLabels = {
  any: { pt: 'Qualquer revisor', en: 'Any reviewer' },
  all: { pt: 'Todos os revisores', en: 'All reviewers' },
  quorum: { pt: 'Quórum', en: 'Quorum' },
};
const reviewRoles = ['technical', 'qa', 'release', 'admin'] as const;

function useProjectRepositories() {
  const { session } = useSession();
  const projectId = useProjectAdmin()?.project.id ?? session?.user.projectId ?? '';
  return useResource<GitRepositoryView[]>(
    `/projects/${encodeURIComponent(projectId)}/git-repositories`,
  );
}

/** Repositório Git e publicação de uma etapa de desenvolvimento (P08). */
export function DevelopmentStepConfig({
  node,
  setConfigValues,
}: {
  node: FlowNode;
  setConfigValues: (values: Record<string, unknown>) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const repositories = useProjectRepositories();
  if (node.op !== 'copilot_task' || copilotMode(node) !== 'develop') return null;
  const current = developmentNodeConfig(node);
  const available = (repositories.data ?? []).filter(
    (repository) => !repository.archived || repository.id === current.repositoryId,
  );
  return (
    <fieldset className="flow-fieldset">
      <legend>{t('Repositório Git', 'Git repository')}</legend>
      <label>
        {t('Repositório', 'Repository')}
        <select
          value={current.repositoryId ?? ''}
          onChange={(event) =>
            setConfigValues(
              event.target.value
                ? { repositoryId: event.target.value }
                : { repositoryId: undefined, publish: undefined },
            )
          }
        >
          <option value="">
            {t('Sem repositório (proposta de diff)', 'No repository (diff proposal)')}
          </option>
          {available.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.name} ({repository.baseBranch})
            </option>
          ))}
        </select>
      </label>
      {current.repositoryId && (
        <label>
          {t('Publicação', 'Publication')}
          <select
            value={current.publish}
            onChange={(event) =>
              setConfigValues({
                publish: event.target.value === 'none' ? undefined : event.target.value,
              })
            }
          >
            {developmentPublishModes.map((mode) => (
              <option key={mode} value={mode}>
                {publishLabels[mode][lang]}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="muted">
        {t(
          'Com repositório, o Copilot trabalha num checkout isolado (branch zeroops/…, base fixa) e os testes configurados correm sobre o commit produzido.',
          'With a repository, Copilot works on an isolated checkout (zeroops/… branch, fixed base) and the configured tests run on the produced commit.',
        )}
      </p>
    </fieldset>
  );
}

/** Entrega por pipeline (P09): pipeline do projeto e decisão de review exigida. */
export function DeliveryStepConfig(props: {
  node: FlowNode;
  definition: FlowDefinition;
  setConfigValues: (values: Record<string, unknown>) => void;
}) {
  if (props.node.op !== 'action' || props.node.config.action !== 'deliver') return null;
  return <DeliveryFields {...props} />;
}

function DeliveryFields({
  node,
  definition,
  setConfigValues,
}: {
  node: FlowNode;
  definition: FlowDefinition;
  setConfigValues: (values: Record<string, unknown>) => void;
}) {
  const { t } = useIdentityLocale();
  const { session } = useSession();
  const projectId = useProjectAdmin()?.project.id ?? session?.user.projectId ?? '';
  const pipelines = useResource<ProjectPipelineView[]>(
    `/projects/${encodeURIComponent(projectId)}/pipelines`,
  );
  const current = deliveryNodeConfig(node);
  const available = (pipelines.data ?? []).filter(
    (pipeline) => !pipeline.archived || pipeline.id === current.pipelineId,
  );
  const reviews = definition.nodes.filter(
    (item) => item.op === 'human_decision' && flowReviewConfig(item),
  );
  return (
    <fieldset className="flow-fieldset">
      <legend>{t('Entrega', 'Delivery')}</legend>
      <label>
        {t('Pipeline do projeto *', 'Project pipeline *')}
        <select
          value={current.pipelineId ?? ''}
          onChange={(event) => setConfigValues({ pipelineId: event.target.value || undefined })}
        >
          <option value="">{t('— escolher —', '— choose —')}</option>
          {available.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name} ({pipeline.environment}, {pipeline.targetBranch})
            </option>
          ))}
        </select>
      </label>
      {pipelines.data && available.length === 0 && (
        <p className="muted">
          {t(
            'Sem pipelines: configure-as em «Pipelines de entrega».',
            'No pipelines: configure them under «Delivery pipelines».',
          )}
        </p>
      )}
      <label>
        {t('Review exigido *', 'Required review *')}
        <select
          value={current.reviewNode ?? ''}
          onChange={(event) => setConfigValues({ reviewNode: event.target.value || undefined })}
        >
          <option value="">{t('— escolher —', '— choose —')}</option>
          {reviews.map((review) => (
            <option key={review.id} value={review.id}>
              {review.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {t(
          'Só publica o commit aprovado nesse review. Antes de integrar volta a verificar aprovações, permissões e o ticket; se a base mudou, revalida a combinação com os testes do repositório.',
          'Only releases the commit approved in that review. Before integrating it rechecks approvals, permissions and the ticket; if the base moved, it revalidates the combination with the repository tests.',
        )}
      </p>
    </fieldset>
  );
}

/** Review de desenvolvimento numa decisão humana: revisores, regra e separação de funções. */
export function ReviewStepConfig({
  node,
  definition,
  members,
  setConfigValues,
}: {
  node: FlowNode;
  definition: FlowDefinition;
  members: FlowDetail['members'];
  setConfigValues: (values: Record<string, unknown>) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  if (node.op !== 'human_decision') return null;
  const sources = definition.nodes.filter(
    (item) =>
      item.op === 'copilot_task' &&
      copilotMode(item) === 'develop' &&
      typeof item.config.repositoryId === 'string',
  );
  const raw = (node.config.review ?? null) as {
    sourceNode?: string;
    reviewers?: { userIds?: string[]; roles?: string[] };
    rule?: string;
    quorum?: number;
    separationOfDuties?: boolean;
    adminOverride?: boolean;
  } | null;
  const review = raw
    ? {
        sourceNode: raw.sourceNode ?? '',
        reviewers: { userIds: raw.reviewers?.userIds ?? [], roles: raw.reviewers?.roles ?? [] },
        rule: raw.rule ?? 'any',
        ...(raw.quorum !== undefined ? { quorum: raw.quorum } : {}),
        separationOfDuties: raw.separationOfDuties ?? true,
        adminOverride: raw.adminOverride ?? false,
      }
    : null;
  const save = (next: typeof review) => setConfigValues({ review: next ?? undefined });
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
  return (
    <fieldset className="flow-fieldset">
      <legend>{t('Review de desenvolvimento', 'Development review')}</legend>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(review)}
          disabled={!review && sources.length === 0}
          onChange={(event) =>
            save(
              event.target.checked
                ? {
                    sourceNode: sources[0]?.id ?? '',
                    reviewers: { userIds: [], roles: ['technical'] },
                    rule: 'any',
                    separationOfDuties: true,
                    adminOverride: false,
                  }
                : null,
            )
          }
        />
        {t(
          'Esta decisão é um review do commit desenvolvido',
          'This decision reviews the developed commit',
        )}
      </label>
      {!review && sources.length === 0 && (
        <p className="muted">
          {t(
            'Precisa de uma etapa de desenvolvimento com repositório Git.',
            'Requires a development step with a Git repository.',
          )}
        </p>
      )}
      {review && (
        <>
          <label>
            {t('Etapa revista', 'Reviewed step')}
            <select
              value={review.sourceNode}
              onChange={(event) => save({ ...review, sourceNode: event.target.value })}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flow-fieldset">
            <legend>{t('Grupos revisores', 'Reviewer groups')}</legend>
            {reviewRoles.map((role) => (
              <label key={role} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={review.reviewers.roles.includes(role)}
                  onChange={(event) =>
                    save({
                      ...review,
                      reviewers: {
                        ...review.reviewers,
                        roles: toggle(review.reviewers.roles, role, event.target.checked),
                      },
                    })
                  }
                />
                {role}
              </label>
            ))}
          </fieldset>
          <fieldset className="flow-fieldset">
            <legend>{t('Revisores', 'Reviewers')}</legend>
            {members
              .filter((member) => member.role !== 'client')
              .map((member) => (
                <label key={member.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={review.reviewers.userIds.includes(member.id)}
                    onChange={(event) =>
                      save({
                        ...review,
                        reviewers: {
                          ...review.reviewers,
                          userIds: toggle(
                            review.reviewers.userIds,
                            member.id,
                            event.target.checked,
                          ),
                        },
                      })
                    }
                  />
                  {member.displayName}
                </label>
              ))}
          </fieldset>
          <label>
            {t('Regra de aprovação', 'Approval rule')}
            <select
              value={review.rule}
              onChange={(event) => {
                const rest = { ...review };
                delete rest.quorum;
                save(
                  event.target.value === 'quorum'
                    ? { ...rest, rule: 'quorum', quorum: 2 }
                    : { ...rest, rule: event.target.value },
                );
              }}
            >
              {reviewRules.map((rule) => (
                <option key={rule} value={rule}>
                  {ruleLabels[rule][lang]}
                </option>
              ))}
            </select>
          </label>
          {review.rule === 'quorum' && (
            <label>
              {t('Aprovações necessárias', 'Required approvals')}
              <input
                type="number"
                min={1}
                max={20}
                value={review.quorum ?? 1}
                onChange={(event) =>
                  save({ ...review, quorum: Math.max(1, Number(event.target.value) || 1) })
                }
              />
            </label>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={review.separationOfDuties}
              onChange={(event) => save({ ...review, separationOfDuties: event.target.checked })}
            />
            {t('O autor do pedido não pode rever', 'The ticket author cannot review')}
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={review.adminOverride}
              onChange={(event) => save({ ...review, adminOverride: event.target.checked })}
            />
            {t(
              'Permitir override auditado de administrador',
              'Allow audited administrator override',
            )}
          </label>
        </>
      )}
    </fieldset>
  );
}
