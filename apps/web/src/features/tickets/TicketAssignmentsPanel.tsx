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
}: {
  ticket: Ticket;
  assignments: TicketAssignments;
  onChanged: (message: string) => void;
}) {
  const { session, request } = useSession();
  const { t } = useIdentityLocale();
  const isProjectAdmin = session?.user.role === 'admin';
  const people = useResource<ManagedUser[]>(isProjectAdmin ? '/users' : null);
  const mutation = useMutation();
  const [values, setValues] = useState({
    clientUserId: assignments.client?.userId ?? '',
    technicalUserId: assignments.technical?.userId ?? '',
    qaUserId: assignments.qa?.userId ?? '',
    releaseUserId: assignments.release?.userId ?? '',
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const input = ticketAssignmentsInputSchema.safeParse({
        expectedVersion: ticket.version,
        clientUserId: data.get('clientUserId') || null,
        technicalUserId: data.get('technicalUserId') || null,
        qaUserId: data.get('qaUserId') || null,
        releaseUserId: data.get('releaseUserId') || null,
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
              {t(
                'Cada etapa exige uma pessoa diferente com acesso ativo.',
                'Each stage requires a different person with active access.',
              )}
            </p>
            {mutation.error && <Notice>{mutation.error}</Notice>}
            <form className="stack" onSubmit={submit}>
              <fieldset disabled={mutation.busy} className="stack">
                <legend className="sr-only">
                  {t('Atribuir responsáveis por etapa', 'Assign owners per stage')}
                </legend>
                {stages.map(([stage, field, label, role]) => {
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
          {stages.map(([stage, , label]) => (
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
