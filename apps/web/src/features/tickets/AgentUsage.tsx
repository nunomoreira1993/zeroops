import type { AgentModelOption, AgentQuota, AgentUsage } from '@zeroops/contracts';
import { useIdentityLocale, type Locale } from '../../lib/identity';
import { formatDateTime, intlLocale } from './labels';

const premiumFormat = (locale: Locale) =>
  new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 });
const tokenFormat = (locale: Locale) =>
  new Intl.NumberFormat(intlLocale(locale), {
    notation: 'compact',
    maximumFractionDigits: 1,
  });

function usageModelName(id: string, models?: AgentModelOption[]) {
  const text =
    models?.find((model) => model.id === id)?.name ??
    id
      .replace(/[-_]/g, ' ')
      .replace(/\b(gpt|claude|gemini|copilot|hydrafusion)\b/gi, (word) =>
        word.toLowerCase() === 'gpt' ? 'GPT' : word.charAt(0).toUpperCase() + word.slice(1),
      );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatPremium(value: number, locale: Locale = 'pt-PT') {
  return `${reportedAmount(value, locale)} premium`;
}

function reportedAmount(value: number, locale: Locale) {
  const format = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 9 });
  return value > 0 && value < 0.000000001 ? `<${format.format(0.000000001)}` : format.format(value);
}

export function formatTokens(value: number, locale: Locale = 'pt-PT') {
  return `${tokenFormat(locale).format(value)} tokens`;
}

export function usageCostText(usage: AgentUsage, locale: Locale) {
  const t = (pt: string, en: string) => (locale === 'en' ? en : pt);
  const status = usage.costStatus ?? 'legacy';
  if (status === 'legacy')
    return t('Custo indisponível · registo antigo', 'Cost unavailable · legacy record');
  if (status === 'unavailable') return t('Custo indisponível', 'Cost unavailable');
  if (status === 'partial' && usage.costUnit === null)
    return t('Custo parcial · ver unidades', 'Partial cost · view units');
  const value =
    usage.costUnit === 'ai_credits'
      ? usage.aiCredits
      : usage.costUnit === 'premium_requests'
        ? usage.premiumRequests
        : null;
  if (value === null || value === undefined || !Number.isFinite(value))
    return t('Custo indisponível', 'Cost unavailable');
  const number = reportedAmount(value, locale);
  const unit =
    usage.costUnit === 'ai_credits' ? t('créditos IA', 'AI credits') : 'premium requests';
  return `${number} ${unit}${status === 'partial' ? t(' · subtotal', ' · subtotal') : ''}`;
}

/** Reported billing only: old token estimates and absent cost never imply free usage. */
export function UsageBadge({
  usage,
  label,
  models,
}: {
  usage: AgentUsage;
  label?: string;
  models?: AgentModelOption[];
}) {
  const { locale, t } = useIdentityLocale();
  const numbers = intlLocale(locale);
  const modelNames = [...new Set(usage.models.map((id) => usageModelName(id, models)))];
  const completeness =
    usage.costStatus === 'complete'
      ? t('Total completo', 'Complete total')
      : usage.costStatus === 'partial'
        ? t(
            'Subtotal: custo de algumas chamadas indisponível.',
            'Subtotal: cost unavailable for some calls.',
          )
        : usage.costStatus === 'legacy' || usage.costStatus === undefined
          ? t('Registo antigo sem custo confirmado.', 'Legacy record without confirmed cost.')
          : t('O runtime não reportou custo.', 'The runtime did not report cost.');
  return (
    <details className="agent-usage-details">
      <summary className="agent-usage-badge">
        {label && <span className="agent-usage-label">{label}</span>}
        <strong>{usageCostText(usage, locale)}</strong>
        <span>{formatTokens(usage.inputTokens + usage.outputTokens, locale)}</span>
        <span className="agent-usage-detail-label">{t('Consumo', 'Usage')}</span>
      </summary>
      <div className="agent-usage-breakdown">
        <p>{completeness}</p>
        <dl>
          <dt>{t('Modelos usados', 'Models used')}</dt>
          <dd>{modelNames.join(', ') || t('Não reportados', 'Not reported')}</dd>
          <dt>{t('Chamadas ao modelo', 'Model calls')}</dt>
          <dd>{usage.modelCalls.toLocaleString(numbers)}</dd>
          <dt>{t('Tokens de entrada', 'Input tokens')}</dt>
          <dd>{usage.inputTokens.toLocaleString(numbers)}</dd>
          <dt>{t('Tokens de saída', 'Output tokens')}</dt>
          <dd>{usage.outputTokens.toLocaleString(numbers)}</dd>
          <dt>{t('Cache lida', 'Cache read')}</dt>
          <dd>{usage.cacheReadTokens.toLocaleString(numbers)}</dd>
          <dt>{t('Cache escrita', 'Cache written')}</dt>
          <dd>
            {usage.cacheWriteTokens?.toLocaleString(numbers) ?? t('Não reportada', 'Not reported')}
          </dd>
          {typeof usage.aiCredits === 'number' && (
            <>
              <dt>{t('Créditos IA reportados', 'Reported AI credits')}</dt>
              <dd>{reportedAmount(usage.aiCredits, locale)}</dd>
            </>
          )}
          {usage.costStatus === 'partial' &&
            usage.costUnit === null &&
            usage.premiumRequests > 0 && (
              <>
                <dt>Premium requests</dt>
                <dd>{reportedAmount(usage.premiumRequests, locale)}</dd>
              </>
            )}
          <dt>{t('Fonte do custo', 'Cost source')}</dt>
          <dd>
            {usage.costUnit === 'ai_credits'
              ? 'Copilot · nano-AIU / 1 000 000 000'
              : usage.costUnit === 'premium_requests'
                ? t('Premium requests reportados pelo runtime', 'Runtime-reported premium requests')
                : t('Indisponível', 'Unavailable')}
          </dd>
        </dl>
        {!!usage.modelUsage?.length && (
          <div className="agent-usage-models">
            {usage.modelUsage.map((entry) => (
              <section key={entry.model}>
                <strong>{usageModelName(entry.model, models)}</strong>
                <dl>
                  <dt>{t('Chamadas', 'Calls')}</dt>
                  <dd>{entry.modelCalls.toLocaleString(numbers)}</dd>
                  <dt>{t('Entrada / saída', 'Input / output')}</dt>
                  <dd>
                    {entry.inputTokens.toLocaleString(numbers)} /{' '}
                    {entry.outputTokens.toLocaleString(numbers)}
                  </dd>
                  <dt>{t('Cache lida / escrita', 'Cache read / written')}</dt>
                  <dd>
                    {entry.cacheReadTokens.toLocaleString(numbers)} /{' '}
                    {entry.cacheWriteTokens?.toLocaleString(numbers) ?? '—'}
                  </dd>
                  <dt>{t('Créditos IA', 'AI credits')}</dt>
                  <dd>
                    {entry.aiCreditsStatus !== 'unavailable' && typeof entry.aiCredits === 'number'
                      ? `${reportedAmount(entry.aiCredits, locale)}${entry.aiCreditsStatus === 'partial' ? t(' · subtotal', ' · subtotal') : ''}`
                      : t('Indisponíveis', 'Unavailable')}
                  </dd>
                </dl>
              </section>
            ))}
          </div>
        )}
        <p className="field-hint">
          {t(
            'Tokens não determinam o custo. Nenhuma conversão para euros ou desconto estimado.',
            'Tokens do not determine cost. No euro conversion or estimated discount.',
          )}
        </p>
      </div>
    </details>
  );
}

/** Quota de premium requests da conta Copilot do projeto. */
export function QuotaBadge({ quota }: { quota: AgentQuota }) {
  const { locale, t } = useIdentityLocale();
  const format = premiumFormat(locale);
  const low = !quota.unlimited && quota.remainingPercentage < 10;
  const text = quota.unlimited
    ? t('Quota ilimitada', 'Unlimited quota')
    : `Quota: ${format.format(quota.used)}/${quota.entitlement} · ${format.format(quota.remainingPercentage)}% ${t('livre', 'free')}`;
  const reset = quota.resetDate
    ? `${t('Repõe em', 'Resets on')} ${formatDateTime(quota.resetDate, locale)}`
    : null;
  return (
    <span
      className={`agent-usage-badge agent-quota${low ? ' agent-quota-low' : ''}`}
      title={[reset, quota.overage ? `${t('Excedente', 'Overage')}: ${quota.overage}` : null]
        .filter(Boolean)
        .join('\n')}
    >
      {text}
    </span>
  );
}
