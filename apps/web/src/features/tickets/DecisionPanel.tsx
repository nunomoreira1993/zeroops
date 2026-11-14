import { useState, type FormEvent } from 'react';
import { decisionSchema, type Capabilities, type TicketDetail } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { ticketLabels } from './labels';
import { useSession } from '../../lib/session';
import { decisionRoles } from './workflow';

export function DecisionPanel({
  detail,
  onChanged,
}: {
  detail: TicketDetail;
  onChanged: (message: string) => void;
}) {
  const { session, request } = useSession();
  const { locale, t } = useIdentityLocale();
  const roleLabels = ticketLabels(locale).role;
  const mutation = useMutation();
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const expectedRole = decisionRoles[detail.ticket.status];
  const capable = useResource<Capabilities>(expectedRole ? '/capabilities' : null);
  if (!expectedRole || !session) return null;
  const assignee = detail.assignments[expectedRole];
  const canDecide = session.user.role === expectedRole && assignee?.userId === session.user.id;
  const blocked =
    (detail.ticket.status === 'awaiting_technical' && capable.data?.implementation === false) ||
    (detail.ticket.status === 'awaiting_release' && capable.data?.deployment === false);
  const candidate = ['awaiting_qa', 'awaiting_release'].includes(detail.ticket.status);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const result = decisionSchema.safeParse({
        expectedVersion: detail.ticket.version,
        artifactHash: detail.approvalHash,
        decision,
        notes: String(data.get('notes') ?? '').trim(),
      });
      if (!result.success)
        throw new Error(
          t(
            'A decisão não pode ser enviada: verifique o artefacto e as notas.',
            'The decision cannot be submitted: check the artifact and the notes.',
          ),
        );
      if (decision === 'reject' && !result.data.notes)
        throw new Error(t('Indique o motivo da rejeição.', 'Provide the reason for rejection.'));
      await request(`/tickets/${encodeURIComponent(detail.ticket.id)}/decisions`, {
        method: 'POST',
        body: result.data,
      });
      onChanged(
        decision === 'approve'
          ? t(
              'Aprovação registada. O pedido avançou para a próxima etapa.',
              'Approval recorded. The ticket moved to the next stage.',
            )
          : t(
              'Rejeição registada. O pedido regressou à análise.',
              'Rejection recorded. The ticket returned to analysis.',
            ),
      );
    });
  };
  return (
    <section className="panel decision-panel">
      <div className="section-heading">
        <span className="feature-icon">
          <Icon name="shield" />
        </span>
        <div>
          <p className="decision-kicker">{t('Decisão necessária', 'Decision required')}</p>
          <h2>{roleLabels[expectedRole]}</h2>
        </div>
      </div>
      {!canDecide ? (
        <p className="muted">
          {assignee ? (
            <>
              {t('Esta decisão está atribuída a', 'This decision is assigned to')}{' '}
              <strong>{assignee.displayName}</strong>
              {session.user.role !== expectedRole &&
                t(
                  `, com o perfil ${roleLabels[expectedRole]}. Apenas esta pessoa pode decidir.`,
                  `, with the ${roleLabels[expectedRole]} role. Only this person can decide.`,
                )}
              {session.user.role === expectedRole &&
                t(' Apenas esta pessoa pode decidir.', ' Only this person can decide.')}
            </>
          ) : (
            <>
              {t(
                'Ainda não foi atribuído um responsável ativo a esta etapa.',
                'No active owner has been assigned to this stage yet.',
              )}
            </>
          )}
        </p>
      ) : (
        <div className="stack">
          <p>
            {candidate
              ? t(
                  'Esta decisão fica associada ao artefacto de execução identificado abaixo, não apenas à proposta.',
                  'This decision is linked to the execution artifact identified below, not just to the proposal.',
                )
              : t(
                  'Reveja a proposta, os critérios de aceitação e os riscos antes de decidir.',
                  'Review the proposal, acceptance criteria and risks before deciding.',
                )}
          </p>
          {blocked && (
            <Notice tone="warning">
              {t(
                'A infraestrutura necessária ainda está bloqueada. A aprovação não será consumida enquanto a integração não estiver validada. Pode rejeitar a proposta ou aguardar.',
                'The required infrastructure is still blocked. The approval will not be consumed until the integration is validated. You can reject the proposal or wait.',
              )}{' '}
              <a href="#integrations">{t('Ver integrações', 'View integrations')}</a>.
            </Notice>
          )}
          {capable.error && (
            <Notice tone="warning">
              {t(
                'Não foi possível confirmar as integrações. O serviço voltará a validar todas as condições ao receber a decisão.',
                'Could not confirm the integrations. The service will revalidate all conditions when it receives the decision.',
              )}
            </Notice>
          )}
          {!detail.approvalHash ? (
            <Notice tone="warning">
              {t(
                'Ainda não existe um artefacto verificável para esta aprovação. Atualize o pedido depois de a equipa técnica disponibilizar o artefacto.',
                'There is no verifiable artifact for this approval yet. Refresh the ticket after the technical team provides the artifact.',
              )}
            </Notice>
          ) : (
            <form className="stack" onSubmit={submit}>
              <details className="artifact-details">
                <summary>
                  {t('Artefacto associado à decisão', 'Artifact linked to the decision')}
                </summary>
                <code className="artifact-hash">{detail.approvalHash}</code>
              </details>
              {candidate && (
                <p className="field-hint">
                  {t(
                    'A evidência de execução não é disponibilizada por este portal. Valide-a com a equipa responsável antes de aprovar.',
                    'Execution evidence is not provided by this portal. Validate it with the responsible team before approving.',
                  )}
                </p>
              )}
              {mutation.error && (
                <Notice>
                  {mutation.error}{' '}
                  {t(
                    'Nenhuma aprovação é apresentada como concluída sem confirmação do serviço.',
                    'No approval is shown as completed without confirmation from the service.',
                  )}
                </Notice>
              )}
              <fieldset className="stack" disabled={mutation.busy}>
                <legend className="sr-only">{t('Registar decisão', 'Record decision')}</legend>
                <label>
                  {t('Decisão', 'Decision')}
                  <select
                    value={decision}
                    onChange={(event) => setDecision(event.target.value as 'approve' | 'reject')}
                  >
                    <option value="approve">{t('Aprovar esta etapa', 'Approve this stage')}</option>
                    <option value="reject">
                      {t('Rejeitar e devolver à análise', 'Reject and return to analysis')}
                    </option>
                  </select>
                </label>
                <label>
                  {decision === 'reject'
                    ? t('Motivo da rejeição', 'Rejection reason')
                    : t('Notas da aprovação (opcional)', 'Approval notes (optional)')}
                  <textarea
                    name="notes"
                    rows={3}
                    required={decision === 'reject'}
                    maxLength={5000}
                  />
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" required key={decision} />
                  <span>
                    {t(
                      'Revi o conteúdo desta versão e confirmo a minha decisão.',
                      'I reviewed the content of this version and confirm my decision.',
                    )}
                  </span>
                </label>
                <button
                  type="submit"
                  className={`button ${decision === 'reject' ? 'button-danger' : 'button-primary'}`}
                  disabled={mutation.busy}
                >
                  {mutation.busy
                    ? t('A registar…', 'Recording…')
                    : decision === 'reject'
                      ? t('Confirmar rejeição', 'Confirm rejection')
                      : t('Confirmar aprovação', 'Confirm approval')}
                  <Icon name={decision === 'reject' ? 'arrow' : 'check'} size={17} />
                </button>
              </fieldset>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
