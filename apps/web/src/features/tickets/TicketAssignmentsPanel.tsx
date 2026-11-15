import { useState, type FormEvent } from 'react';
import {
  ticketAssignmentsInputSchema,
  type ManagedUser,
  type Ticket,
  type TicketAssignments,
} from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';

const stages = [
  ['client', 'clientUserId', ['Cliente responsável', 'Responsible client'], 'client'],
  ['technical', 'technicalUserId', ['Responsável técnico', 'Technical lead'], 'technical'],
  ['qa', 'qaUserId', ['Qualidade / QA', 'Quality / QA'], 'qa'],
  ['release', 'releaseUserId', ['Responsável de release', 'Release owner'], 'release'],
] as const;

export function TicketAssignmentsPanel({
  ticket,
  assignments,
  onChanged,
  flowRoles = null,
}: {
  ticket: Ticket;
  assignments: TicketAssignments;
  onChanged: (message: string) => void;
  /**
   * Papéis usados como responsável pelas etapas do fluxo do ticket. `null` = pedido anterior aos
   * fluxos (mostra as quatro etapas originais).
   */
  flowRoles?: readonly string[] | null;
}) {
  const { session, request } = useSession();
  const { t } = useIdentityLocale();
  const isProjectAdmin = session?.user.role === 'admin';
  const visible = stages.filter(
    ([stage]) => flowRoles === null || flowRoles.includes(stage) || assignments[stage],
  );
  const people = useResource<ManagedUser[]>(isProjectAdmin && visible.length ? '/users' : null);
  const mutation = useMutation();
  const [values, setValues] = useState({
    clientUserId: assignments.client?.userId ?? '',
    technicalUserId: assignments.technical?.userId ?? '',
    qaUserId: assignments.qa?.userId ?? '',
    releaseUserId: assignments.release?.userId ?? '',
  });
  if (!visible.length) return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void mutation.run(async () => {
      // O backend substitui as quatro atribuições: as etapas ocultas mantêm o valor atual.
      const input = ticketAssignmentsInputSchema.safeParse({
        expectedVersion: ticket.version,
        clientUserId: values.clientUserId || null,
        technicalUserId: values.technicalUserId || null,
        qaUserId: values.qaUserId || null,
        releaseUserId: values.releaseUserId || null,
      });
      if (!input.success)
        throw new Error(
          t(
            'Reveja as pessoas atribuídas a cada etapa.',
            'Check the people assigned to each stage.',
          ),
        );
      await request(`/tickets/${encodeURIComponent(ticket.id)}/assignments`, {
        method: 'POST',
        body: input.data,
      });
      onChanged(
        t(
          'Responsáveis atualizados. As alterações ficaram associadas à versão do pedido.',
          'Owners updated. The changes were linked to the ticket version.',
        ),
      );
    });
  };
  return (
    <section className="panel detail-side-panel">
      <h2>{t('Responsáveis', 'Owners')}</h2>
      {isProjectAdmin ? (
        people.loading ? (
          <Loading label={t('A carregar membros do projeto…', 'Loading project members…')} />
        ) : people.error ? (
          <ResourceError error={people.error} retry={people.reload} />
        ) : (
          <>
            <p className="muted">
              {flowRoles === null
                ? t(
                    'Cada etapa exige uma pessoa diferente com acesso ativo.',
                    'Each stage requires a different person with active access.',
                  )
                : t(
                    'Responsáveis por papel usados pelas etapas do fluxo (uma pessoa diferente por papel). Revisores, aprovações e entrega são definidos em cada etapa do fluxo.',
                    'Role owners used by the flow steps (a different person per role). Reviewers, approvals and delivery are defined in each flow step.',
                  )}
            </p>
            {mutation.error && <Notice>{mutation.error}</Notice>}
            <form className="stack" onSubmit={submit}>
              <fieldset disabled={mutation.busy} className="stack">
                <legend className="sr-only">
                  {t('Atribuir responsáveis por etapa', 'Assign owners per stage')}
                </legend>
                {visible.map(([stage, field, label, role]) => {
                  const current = assignments[stage];
                  const available = (people.data ?? []).filter(
                    (person) => !person.disabled && person.role === role,
                  );
                  return (
                    <label key={stage}>
                      {t(label[0], label[1])}
                      <select
                        name={field}
                        value={values[field]}
                        onChange={(event) =>
                          setValues((previous) => ({
                            ...previous,
                            [field]: event.target.value,
                          }))
                        }
                      >
                        <option value="">{t('Por atribuir', 'Unassigned')}</option>
                        {current && !available.some((person) => person.id === current.userId) && (
                          <option value={current.userId} disabled>
                            {current.displayName} · {t('sem acesso ativo', 'no active access')}
                          </option>
                        )}
                        {available.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
                <button className="button button-secondary" disabled={mutation.busy}>
                  {mutation.busy
                    ? t('A guardar…', 'Saving…')
                    : t('Guardar responsáveis', 'Save owners')}
                  <Icon name="check" size={16} />
                </button>
              </fieldset>
            </form>
          </>
        )
      ) : (
        <dl className="metadata-list">
          {visible.map(([stage, , label]) => (
            <div key={stage}>
              <dt>{t(label[0], label[1])}</dt>
              <dd>{assignments[stage]?.displayName ?? t('Por atribuir', 'Unassigned')}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
