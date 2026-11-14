import type { FormEvent } from 'react';
import { proposalInputSchema, type TicketDetail } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { EmptyState, Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { formatDateTime } from './labels';
import { useSession } from '../../lib/session';
import { canPublishProposal } from './workflow';

function ProposalEditor({
  detail,
  onChanged,
}: {
  detail: TicketDetail;
  onChanged: (message: string) => void;
}) {
  const { request } = useSession();
  const mutation = useMutation();
  const { t } = useIdentityLocale();
  const proposal = detail.proposal;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines = (field: string) =>
      String(data.get(field) ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    void mutation.run(async () => {
      const result = proposalInputSchema.safeParse({
        expectedVersion: detail.ticket.version,
        summary: data.get('summary'),
        steps: lines('steps'),
        acceptanceCriteria: lines('acceptanceCriteria'),
        risks: lines('risks'),
      });
      if (!result.success)
        throw new Error(
          t(
            'Reveja a proposta: resumo de 10 a 5000 caracteres, 1 a 30 passos e critérios, até 30 riscos. Cada linha pode ter até 2000 caracteres.',
            'Check the proposal: summary of 10 to 5000 characters, 1 to 30 steps and criteria, up to 30 risks. Each line can have up to 2000 characters.',
          ),
        );
      await request(`/tickets/${encodeURIComponent(detail.ticket.id)}/proposals`, {
        method: 'POST',
        body: result.data,
      });
      onChanged(
        t(
          'Proposta publicada. O pedido aguarda agora a aprovação do cliente.',
          'Proposal published. The ticket now awaits client approval.',
        ),
      );
    });
  };
  return (
    <form className="stack proposal-editor" onSubmit={submit}>
      <Notice tone="warning">
        {t(
          'A publicação cria uma nova versão e volta a pedir aprovação ao cliente. As aprovações anteriores não autorizam esta versão.',
          'Publishing creates a new version and asks the client for approval again. Previous approvals do not authorize this version.',
        )}
      </Notice>
      {mutation.error && (
        <Notice>
          {mutation.error}{' '}
          {t(
            'Se o pedido mudou, atualize os dados antes de voltar a publicar.',
            'If the ticket changed, refresh the data before publishing again.',
          )}
        </Notice>
      )}
      <fieldset disabled={mutation.busy} className="stack">
        <legend className="sr-only">
          {t('Editar proposta técnica', 'Edit technical proposal')}
        </legend>
        <label>
          {t('Resumo da solução', 'Solution summary')}
          <textarea
            name="summary"
            defaultValue={proposal?.summary}
            rows={4}
            required
            minLength={10}
            maxLength={5000}
          />
        </label>
        <label>
          {t('Passos de implementação', 'Implementation steps')}
          <textarea
            name="steps"
            defaultValue={proposal?.steps.join('\n')}
            rows={4}
            required
            aria-describedby="proposal-lines"
          />
        </label>
        <p id="proposal-lines" className="field-hint">
          {t(
            'Um elemento por linha, até 30 linhas em cada campo. Não inclua marcadores nem numeração.',
            'One item per line, up to 30 lines per field. Do not include bullets or numbering.',
          )}
        </p>
        <label>
          {t('Critérios de aceitação', 'Acceptance criteria')}
          <textarea
            name="acceptanceCriteria"
            defaultValue={proposal?.acceptanceCriteria.join('\n')}
            rows={4}
            required
          />
        </label>
        <label>
          {t('Riscos e cuidados', 'Risks and precautions')}{' '}
          <span className="optional">{t('(opcional)', '(optional)')}</span>
          <textarea name="risks" defaultValue={proposal?.risks.join('\n')} rows={3} />
        </label>
        <button
          className="button button-primary align-start"
          type="submit"
          disabled={mutation.busy}
        >
          {mutation.busy
            ? t('A publicar…', 'Publishing…')
            : t('Publicar para aprovação', 'Publish for approval')}
          <Icon name="arrow" size={17} />
        </button>
      </fieldset>
    </form>
  );
}

export function ProposalPanel({
  detail,
  onChanged,
}: {
  detail: TicketDetail;
  onChanged: (message: string) => void;
}) {
  const { session } = useSession();
  const { locale, t } = useIdentityLocale();
  const { proposal, ticket } = detail;
  const editable = session && canPublishProposal(session.user.role, ticket.status);
  return (
    <section className="panel detail-section">
      <div className="panel-heading">
        <div>
          <h2>{t('Proposta de solução', 'Solution proposal')}</h2>
          <p>
            {proposal
              ? `${t('Versão', 'Version')} ${proposal.version} · ${formatDateTime(proposal.createdAt, locale)}`
              : t(
                  'A solução é preparada antes de qualquer implementação.',
                  'The solution is prepared before any implementation.',
                )}
          </p>
        </div>
        <Icon name="code" size={21} />
      </div>
      <div className="panel-padding">
        {proposal ? (
          <div className="proposal-content">
            <h3>{t('Resumo', 'Summary')}</h3>
            <p className="preserve-lines">{proposal.summary}</p>
            <h3>{t('Plano de implementação', 'Implementation plan')}</h3>
            <ol className="content-list">
              {proposal.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            <h3>{t('Critérios de aceitação', 'Acceptance criteria')}</h3>
            <ul className="check-list">
              {proposal.acceptanceCriteria.map((criterion, index) => (
                <li key={index}>
                  <Icon name="check" size={16} />
                  <span>{criterion}</span>
                </li>
              ))}
            </ul>
            <h3>{t('Riscos e cuidados', 'Risks and precautions')}</h3>
            {proposal.risks.length ? (
              <ul className="content-list">
                {proposal.risks.map((risk, index) => (
                  <li key={index}>{risk}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {t(
                  'Não foram registados riscos nesta proposta.',
                  'No risks were recorded in this proposal.',
                )}
              </p>
            )}
            <details className="artifact-details">
              <summary>
                {t('Identificador verificável da proposta', 'Verifiable proposal identifier')}
              </summary>
              <code className="artifact-hash">{proposal.hash}</code>
            </details>
          </div>
        ) : (
          !editable && (
            <EmptyState
              icon="code"
              title={t(
                'A solução ainda está a ser preparada.',
                'The solution is still being prepared.',
              )}
            >
              {t(
                'A proposta ficará disponível aqui para consulta e aprovação.',
                'The proposal will be available here for review and approval.',
              )}
            </EmptyState>
          )
        )}
        {editable &&
          (proposal ? (
            <details className="edit-proposal">
              <summary>
                {t('Rever e publicar uma nova proposta', 'Review and publish a new proposal')}
              </summary>
              <ProposalEditor key={proposal.hash} detail={detail} onChanged={onChanged} />
            </details>
          ) : (
            <ProposalEditor detail={detail} onChanged={onChanged} />
          ))}
      </div>
    </section>
  );
}
