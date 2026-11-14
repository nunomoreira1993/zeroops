import { Loading, Notice } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { IdentityDialog } from '../auth/IdentityForms';

export interface UserDelivery {
  id: string;
  kind: string;
  state: 'pending' | 'processing' | 'delivered' | 'failed' | 'blocked' | 'uncertain';
  attempts: number;
  error_code: string | null;
  created_at: string;
  delivered_at: string | null;
}

export function useDeliveryLabels() {
  const { t } = useIdentityLocale();
  return {
    pending: t('Em fila', 'Queued'),
    processing: t('Em envio', 'Sending'),
    delivered: t('Aceite pelo relay', 'Accepted by relay'),
    failed: t('Falhou', 'Failed'),
    blocked: t('Bloqueado', 'Blocked'),
    uncertain: t('Entrega incerta', 'Uncertain delivery'),
  };
}

export function UserDeliveries({
  userId,
  name,
  onClose,
  onRetry,
}: {
  userId: string;
  name: string;
  onClose: () => void;
  onRetry: (delivery: UserDelivery) => void;
}) {
  const deliveries = useResource<UserDelivery[]>(`/users/${encodeURIComponent(userId)}/deliveries`);
  const { t, locale } = useIdentityLocale();
  const labels = useDeliveryLabels();
  return (
    <IdentityDialog
      title={`${t('Entrega de emails', 'Email delivery')} · ${name}`}
      onClose={onClose}
    >
      <p>
        {t(
          'Aceitação pelo relay não garante entrega à caixa de entrada. Não repita uma entrega incerta; é necessária reconciliação administrativa.',
          'Relay acceptance does not guarantee inbox delivery. Do not repeat uncertain delivery; administrative reconciliation is required.',
        )}
      </p>
      {deliveries.error && (
        <Notice>
          {t('Não foi possível consultar as entregas.', 'Unable to load deliveries.')}
        </Notice>
      )}
      <button
        className="button button-secondary"
        disabled={deliveries.loading}
        onClick={deliveries.reload}
      >
        {t('Atualizar estado', 'Refresh status')}
      </button>
      {deliveries.loading ? (
        <Loading label={t('A carregar…', 'Loading…')} />
      ) : (
        <ul className="delivery-list">
          {(deliveries.data ?? []).map((delivery) => (
            <li key={delivery.id} className="stack">
              <strong>{labels[delivery.state]}</strong>
              <span>
                {t('Tipo', 'Type')}: {delivery.kind} · {t('Tentativas', 'Attempts')}:{' '}
                {delivery.attempts}
              </span>
              <time dateTime={delivery.created_at}>
                {new Date(delivery.created_at).toLocaleString(locale)}
              </time>
              {delivery.delivered_at && (
                <span>
                  {t('Aceite em', 'Accepted at')}:{' '}
                  {new Date(delivery.delivered_at).toLocaleString(locale)}
                </span>
              )}
              {delivery.error_code && (
                <span>
                  {t('Código de diagnóstico', 'Diagnostic code')}:{' '}
                  <code>{delivery.error_code}</code>
                </span>
              )}
              {['failed', 'blocked'].includes(delivery.state) && delivery.attempts < 5 && (
                <button className="button button-secondary" onClick={() => onRetry(delivery)}>
                  {t('Tentar envio novamente', 'Retry delivery')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!deliveries.loading && !deliveries.error && !deliveries.data?.length && (
        <p>{t('Sem entregas registadas.', 'No recorded deliveries.')}</p>
      )}
    </IdentityDialog>
  );
}
