import { useState, type FormEvent } from 'react';
import { createTicketSchema, type Ticket } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { Notice, PageHeader } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { ticketLabels } from './labels';
import { useSession } from '../../lib/session';

export function NewTicketPage() {
  const [description, setDescription] = useState('');
  const { request } = useSession();
  const mutation = useMutation();
  const { locale, t } = useIdentityLocale();
  const labels = ticketLabels(locale);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const values = createTicketSchema.safeParse(Object.fromEntries(data));
      if (!values.success)
        throw new Error(
          t(
            'Reveja os campos: assunto com pelo menos 5 caracteres e descrição com pelo menos 10 caracteres.',
            'Check the fields: subject with at least 5 characters and description with at least 10 characters.',
          ),
        );
      const ticket = await request<Ticket>('/tickets', { method: 'POST', body: values.data });
      window.location.hash = `tickets/${encodeURIComponent(ticket.id)}`;
    });
  };
  return (
    <>
      <a href="#tickets" className="back-link">
        ← {t('Voltar aos pedidos', 'Back to tickets')}
      </a>
      <PageHeader
        title={t('Novo pedido', 'New ticket')}
        description={t(
          'Descreva o pedido com o máximo de contexto para acelerar a análise.',
          'Describe the ticket with as much context as possible to speed up the analysis.',
        )}
      />
      <div className="form-layout">
        <section className="kt-card form-panel">
          <div className="kt-card-header">
            <div>
              <h2 className="kt-card-title">{t('Detalhes do pedido', 'Ticket details')}</h2>
              <p className="card-subtitle">
                {t('Todos os campos são obrigatórios', 'All fields are required')}
              </p>
            </div>
          </div>
          <div className="kt-card-content">
            {mutation.error && <Notice>{mutation.error}</Notice>}
            <form onSubmit={submit}>
              <fieldset disabled={mutation.busy} className="stack">
                <legend className="sr-only">
                  {t('Informação do pedido', 'Ticket information')}
                </legend>
                <label>
                  {t('Assunto', 'Subject')}
                  <input
                    name="title"
                    required
                    minLength={5}
                    maxLength={180}
                    placeholder={t(
                      'Resuma a questão numa frase',
                      'Summarise the issue in one sentence',
                    )}
                  />
                </label>
                <div className="form-row">
                  <label>
                    {t('Tipo de pedido', 'Ticket type')}
                    <select name="category" defaultValue="incident">
                      {Object.entries(labels.category).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('Ambiente', 'Environment')}
                    <select name="environment" defaultValue="production">
                      {(['quality', 'production'] as const).map((value) => (
                        <option key={value} value={value}>
                          {labels.environment[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  {t('Prioridade', 'Priority')}
                  <select name="priority" defaultValue="medium">
                    {Object.entries(labels.priority).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <MarkdownEditor
                  label={t('Descrição', 'Description')}
                  name="description"
                  value={description}
                  onChange={setDescription}
                  required
                  minLength={10}
                  maxLength={20000}
                  rows={8}
                  placeholder={t(
                    'O que aconteceu? O que esperava que acontecesse? Como podemos reproduzir a situação?',
                    'What happened? What did you expect to happen? How can we reproduce it?',
                  )}
                  describedBy="description-hint"
                />
                <p className="field-hint" id="description-hint">
                  {t(
                    'Inclua passos, impacto e referências úteis. Não partilhe palavras-passe, tokens ou dados de pagamento. O envio de ficheiros ainda não está disponível.',
                    'Include steps, impact and useful references. Do not share passwords, tokens or payment data. File uploads are not available yet.',
                  )}
                </p>
                <div className="form-actions">
                  <a className="kt-btn kt-btn-outline" href="#tickets">
                    {t('Cancelar', 'Cancel')}
                  </a>
                  <button className="kt-btn kt-btn-primary" type="submit" disabled={mutation.busy}>
                    {mutation.busy
                      ? t('A criar pedido…', 'Creating ticket…')
                      : t('Criar pedido', 'Create ticket')}
                    <Icon name="arrow" size={16} />
                  </button>
                </div>
              </fieldset>
            </form>
          </div>
        </section>
        <aside className="kt-card guidance-panel">
          <div className="kt-card-header">
            <h2 className="kt-card-title">
              {t('Como descrever o pedido', 'How to describe the ticket')}
            </h2>
          </div>
          <div className="kt-card-content">
            <ul className="guidance-list">
              <li>
                <strong>{t('Impacto', 'Impact')}</strong>
                <span>
                  {t(
                    'O que deixou de funcionar e quem é afetado.',
                    'What stopped working and who is affected.',
                  )}
                </span>
              </li>
              <li>
                <strong>{t('Passos', 'Steps')}</strong>
                <span>
                  {t(
                    'O percurso até ao problema e o resultado esperado.',
                    'The path to the problem and the expected result.',
                  )}
                </span>
              </li>
              <li>
                <strong>{t('Acompanhamento', 'Follow-up')}</strong>
                <span>
                  {t(
                    'A análise, a proposta e cada aprovação ficam associadas ao pedido.',
                    'The analysis, the proposal and each approval are linked to the ticket.',
                  )}
                </span>
              </li>
            </ul>
            <div className="guidance-footnote">
              <Icon name="shield" size={16} />
              <p>
                {t(
                  'Uma proposta só avança depois das aprovações necessárias.',
                  'A proposal only moves forward after the required approvals.',
                )}
              </p>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
