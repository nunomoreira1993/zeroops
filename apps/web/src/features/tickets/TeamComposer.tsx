import { useEffect, useState, type FormEvent } from 'react';
import {
  AGENT_EFFORT_HIGH,
  AGENT_MODEL_AUTO,
  type AgentModelCatalog,
  type AgentModelOption,
  type AgentRun,
} from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale, type Locale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { CommentComposer } from './CommentComposer';
import { intlLocale } from './labels';
import { TeamPicker } from './TeamPicker';

const PREFERENCE_KEY = 'zeroops.copilot-model';

type FusionTier = 'standard' | 'high' | 'max';
type Preference = {
  executionMode: 'copilot' | 'local';
  model: string;
  fusionTier: FusionTier | null;
  reasoningEffort: string | null;
};

const readPreference = (): Preference | null => {
  try {
    const value = JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? 'null') as unknown;
    if (value && typeof value === 'object' && 'model' in value && typeof value.model === 'string')
      return {
        executionMode:
          'executionMode' in value && value.executionMode === 'local' ? 'local' : 'copilot',
        model: value.model,
        fusionTier:
          'fusionTier' in value && ['standard', 'high', 'max'].includes(String(value.fusionTier))
            ? (value.fusionTier as FusionTier)
            : null,
        reasoningEffort:
          'reasoningEffort' in value && typeof value.reasoningEffort === 'string'
            ? value.reasoningEffort
            : 'high' in value && value.high === true
              ? AGENT_EFFORT_HIGH
              : null,
      };
  } catch {
    // Preferência inválida: usa a predefinição.
  }
  return null;
};

/** Multiplicador de premium requests do modelo, como no seletor do VS Code (`1x`, `0.33x`). */
export function modelLabel(option: AgentModelOption, locale: Locale) {
  if (option.multiplier === null) return option.name;
  const value = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(
    option.multiplier,
  );
  return `${option.name} · ${value}x`;
}

/** Catálogo de modelos do projeto; volta a ler enquanto o executor o está a atualizar. */
export function useModelCatalog(ticketId: string | null) {
  const catalog = useResource<AgentModelCatalog>(
    ticketId ? `/tickets/${encodeURIComponent(ticketId)}/agent-models` : null,
  );
  const { reload } = catalog;
  const refreshing = !!catalog.data?.refreshing;
  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setTimeout(reload, 4000);
    return () => window.clearTimeout(timer);
  }, [refreshing, reload, catalog.data]);
  return useLatest(catalog.data, ticketId);
}

/** Último valor carregado: evita que a lista desapareça enquanto um `reload()` está em curso. */
export function useLatest<T>(value: T | null, key: string | null) {
  const [last, setLast] = useState<{ key: string | null; value: T | null }>({ key, value });
  if (last.key !== key) setLast({ key, value });
  else if (value !== null && value !== last.value) setLast({ key, value });
  return value ?? (last.key === key ? last.value : null);
}

/** Nome legível do modelo de um run (`auto`, Fusion ou um modelo concreto). */
export function runModelName(
  run: Pick<AgentRun, 'model' | 'fusionTier'>,
  models: AgentModelOption[] | undefined,
  t: (pt: string, en: string) => string,
) {
  if (!run.model) return t('Modelo da integração', 'Integration model');
  if (run.model === 'fusion')
    return `Fusion ${run.fusionTier ? readableModelName(run.fusionTier) : ''}`.trim();
  if (run.model === AGENT_MODEL_AUTO) return 'Auto';
  return models?.find((option) => option.id === run.model)?.name ?? readableModelName(run.model);
}

export function readableModelName(id: string) {
  const text = id
    .replace(/[-_]/g, ' ')
    .replace(/\b(gpt|claude|gemini|hydrafusion|copilot)\b/gi, (word) =>
      word.toLowerCase() === 'gpt' ? 'GPT' : word.charAt(0).toUpperCase() + word.slice(1),
    );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function runRoutingName(
  run: Pick<AgentRun, 'model' | 'fusionTier' | 'executionMode' | 'reasoningEffort'>,
  models: AgentModelOption[] | undefined,
  t: (pt: string, en: string) => string,
) {
  const mode = run.executionMode ? `${run.executionMode === 'local' ? 'Local' : 'Copilot'} · ` : '';
  return `${mode}${runModelName(run, models, t)}${
    run.model !== 'fusion' && run.reasoningEffort
      ? ` · ${readableModelName(run.reasoningEffort)}`
      : ''
  }`;
}

/**
 * Compositor único do chat da equipa: «Nota» grava uma nota interna; «Copilot» pede uma
 * investigação com o modelo e o esforço escolhidos, ou envia uma mensagem ao run em curso.
 */
export function TeamComposer({
  ticketId,
  closed,
  active,
  catalog,
  draft,
  onDraftChange,
  onChanged,
  onRunsChanged,
}: {
  ticketId: string;
  closed: boolean;
  active: AgentRun | null;
  catalog: AgentModelCatalog | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onChanged: (message: string) => void;
  onRunsChanged: () => void;
}) {
  const { t } = useIdentityLocale();
  const [mode, setMode] = useState<'note' | 'copilot'>('copilot');
  return (
    <div className="team-composer">
      <div
        className="team-composer-modes"
        role="tablist"
        aria-label={t('Tipo de mensagem', 'Message type')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'copilot'}
          onClick={() => setMode('copilot')}
        >
          <Icon name="bot" size={15} />
          {t('Perguntar ao Copilot', 'Ask Copilot')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'note'}
          onClick={() => setMode('note')}
        >
          <Icon name="message" size={15} />
          {t('Nota', 'Note')}
        </button>
      </div>
      {mode === 'note' ? (
        <CommentComposer
          ticketId={ticketId}
          visibility="internal"
          draft={draft}
          onDraftChange={onDraftChange}
          label={t('Nota interna', 'Internal note')}
          placeholder={t(
            'Partilhe contexto com a equipa (o cliente não vê)…',
            'Share context with the team (the client cannot see it)…',
          )}
          hint={t('Interna · apenas equipa.', 'Internal · team only.')}
          submitLabel={t('Adicionar nota', 'Add note')}
          onChanged={onChanged}
        />
      ) : null}
      <div hidden={mode !== 'copilot'}>
        <CopilotForm
          ticketId={ticketId}
          closed={closed}
          active={active}
          catalog={catalog}
          onRunsChanged={onRunsChanged}
        />
      </div>
    </div>
  );
}

function CopilotForm({
  ticketId,
  closed,
  active,
  catalog,
  onRunsChanged,
}: {
  ticketId: string;
  closed: boolean;
  active: AgentRun | null;
  catalog: AgentModelCatalog | null;
  onRunsChanged: () => void;
}) {
  const { request } = useSession();
  const { t, locale } = useIdentityLocale();
  const mutation = useMutation();
  const [text, setText] = useState('');
  const [preference, setPreference] = useState(readPreference);
  const models = catalog?.models ?? [];
  const tiers = (catalog?.routingTiers ?? []).filter(
    (tier) => tier.visible && tier.fusionTier !== null,
  );
  const initialTier = tiers.find((tier) => tier.fusionTier === 'standard' && tier.enabled);
  const individualModels = models.filter(
    (model) => model.id !== AGENT_MODEL_AUTO && model.id !== 'fusion' && !model.fusion,
  );
  const initialModel =
    individualModels.find((model) => model.id === catalog?.defaultModel) ?? individualModels[0];
  const choice: Preference = preference ?? {
    executionMode: 'copilot',
    model: initialTier ? 'fusion' : (initialModel?.id ?? ''),
    fusionTier: initialTier ? 'standard' : null,
    reasoningEffort: null,
  };
  const selectedId = choice.model;
  const selected = models.find((option) => option.id === selectedId);
  const selectedTier = tiers.find((tier) => tier.fusionTier === choice.fusionTier);
  const fusion = choice.model === 'fusion';
  const valid = fusion
    ? choice.executionMode === 'copilot' &&
      !!selectedTier?.enabled &&
      choice.reasoningEffort === null
    : !!selected &&
      !selected.fusion &&
      (choice.executionMode === 'local' || selected.id !== AGENT_MODEL_AUTO) &&
      (choice.reasoningEffort === null || selected.efforts.includes(choice.reasoningEffort));
  const running = active?.status === 'running';
  const queued = active?.status === 'queued';
  const locked = !!active;
  const blocked = closed || queued || !!active?.cancelRequested;
  const displayed: Preference = active
    ? {
        executionMode: active.executionMode ?? 'copilot',
        model: active.model ?? '',
        fusionTier: active.fusionTier ?? null,
        reasoningEffort: active.reasoningEffort,
      }
    : choice;
  const displayedFusion = displayed.model === 'fusion';
  const displayedModel = models.find((model) => model.id === displayed.model);
  const displayedTier = tiers.find((tier) => tier.fusionTier === displayed.fusionTier);
  const tierLabel =
    displayedTier?.name ??
    (displayed.fusionTier
      ? readableModelName(displayed.fusionTier)
      : t('Nível indisponível', 'Tier unavailable'));
  const tierPromo = displayedTier?.promo;
  const [promoClock, setPromoClock] = useState(0);
  const now = Date.now();
  useEffect(() => {
    const boundaries = [tierPromo?.startsAt, tierPromo?.endsAt]
      .filter((date): date is string => typeof date === 'string')
      .map(Date.parse)
      .filter((time) => Number.isFinite(time) && time > Date.now());
    if (!boundaries.length) return;
    const timer = window.setTimeout(
      () => setPromoClock((value) => value + 1),
      Math.min(Math.min(...boundaries) - Date.now(), 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [tierPromo?.startsAt, tierPromo?.endsAt, promoClock]);
  const promo =
    tierPromo &&
    displayedTier?.enabled &&
    typeof tierPromo.discountPercent === 'number' &&
    Number.isFinite(tierPromo.discountPercent) &&
    tierPromo.discountPercent > 0 &&
    typeof tierPromo.startsAt === 'string' &&
    typeof tierPromo.endsAt === 'string' &&
    Number.isFinite(Date.parse(tierPromo.startsAt)) &&
    Number.isFinite(Date.parse(tierPromo.endsAt)) &&
    now >= Date.parse(tierPromo.startsAt) &&
    now < Date.parse(tierPromo.endsAt)
      ? tierPromo
      : null;

  const remember = (next: Preference) => {
    setPreference(next);
    try {
      window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next));
    } catch {
      // Sem localStorage: a escolha vale só para esta página.
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.busy || blocked || (!active && !valid)) return;
    const value = text.trim();
    void mutation.run(async () => {
      if (running && active) {
        if (!value)
          throw new Error(
            t('Escreva a mensagem para o Copilot.', 'Write the message for Copilot.'),
          );
        await request(
          `/tickets/${encodeURIComponent(ticketId)}/agent-runs/${encodeURIComponent(active.id)}/inputs`,
          { method: 'POST', body: { kind: 'message', text: value } },
        );
      } else {
        await request(`/tickets/${encodeURIComponent(ticketId)}/agent-runs`, {
          method: 'POST',
          body: {
            ...(value ? { instructions: value } : {}),
            executionMode: choice.executionMode,
            model: selectedId,
            fusionTier: fusion ? choice.fusionTier : null,
            reasoningEffort: fusion ? null : choice.reasoningEffort,
          },
        });
        remember(choice);
      }
      setText('');
      onRunsChanged();
    });
  };

  const cancel = () =>
    active &&
    void mutation.run(async () => {
      await request(
        `/tickets/${encodeURIComponent(ticketId)}/agent-runs/${encodeURIComponent(active.id)}/cancel`,
        { method: 'POST', body: {} },
      );
      onRunsChanged();
    });

  const hint = closed
    ? t(
        'O pedido está fechado: reabra-o para voltar a investigar.',
        'The ticket is closed: reopen it to investigate again.',
      )
    : queued
      ? t(
          'A investigação está em fila. Pode escrever quando começar.',
          'The investigation is queued. You can write once it starts.',
        )
      : running
        ? t(
            'Seleção bloqueada: a mensagem mantém o modo, modelo e nível desta investigação.',
            'Selection locked: the message retains this investigation’s mode, model and tier.',
          )
        : t(
            'Interna · o cliente não vê. A resposta ao cliente só segue depois de revista.',
            'Internal · the client cannot see it. The client reply is only sent after review.',
          );

  return (
    <form className="comment-form team-copilot-form" onSubmit={submit}>
      <fieldset disabled={mutation.busy} className="stack">
        <legend className="sr-only">{t('Pedido ao Copilot', 'Request to Copilot')}</legend>
        {mutation.error && <Notice>{mutation.error}</Notice>}
        <label className="sr-only" htmlFor={`copilot-text-${ticketId}`}>
          {t('Mensagem para o Copilot', 'Message to Copilot')}
        </label>
        <textarea
          id={`copilot-text-${ticketId}`}
          rows={3}
          maxLength={4000}
          value={text}
          disabled={blocked}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey))
              event.currentTarget.form?.requestSubmit();
          }}
          placeholder={
            running
              ? t(
                  'Ex.: verifique também os pagamentos desta encomenda no Shift4.',
                  'E.g.: also check the payments for this order in Shift4.',
                )
              : t(
                  'Ex.: confirme o método de pagamento e a captura da encomenda referida (opcional).',
                  'E.g.: confirm the payment method and capture for the referenced order (optional).',
                )
          }
        />
        <div className="team-copilot-toolbar">
          <TeamPicker
            label={t('Modo de execução', 'Execution mode')}
            icon="bot"
            value={displayed.executionMode}
            display={displayed.executionMode === 'local' ? 'Local' : 'Copilot'}
            disabled={locked || closed || mutation.busy}
            options={[
              {
                id: 'copilot',
                label: 'Copilot',
                description: t(
                  'Fusion ou modelo individual · servidor ZeroOps.',
                  'Fusion or individual model · ZeroOps server.',
                ),
              },
              {
                id: 'local',
                label: 'Local',
                description: t(
                  'Auto ou modelo individual · Copilot no servidor, não offline nem gratuito.',
                  'Auto or individual model · server Copilot, not offline or free.',
                ),
              },
            ]}
            onChange={(value) => {
              const executionMode = value === 'local' ? 'local' : 'copilot';
              if (executionMode === 'local' && fusion)
                remember({
                  executionMode,
                  model: AGENT_MODEL_AUTO,
                  fusionTier: null,
                  reasoningEffort: null,
                });
              else if (executionMode === 'copilot' && choice.model === AGENT_MODEL_AUTO)
                remember({
                  executionMode,
                  model: initialTier ? 'fusion' : (initialModel?.id ?? ''),
                  fusionTier: initialTier ? 'standard' : null,
                  reasoningEffort: null,
                });
              else remember({ ...choice, executionMode });
            }}
          />
          <TeamPicker
            label={t('Modelo do Copilot', 'Copilot model')}
            icon={displayedFusion ? 'pulse' : undefined}
            value={displayed.model}
            display={
              displayedFusion
                ? 'Fusion'
                : displayedModel
                  ? modelLabel(displayedModel, locale)
                  : displayed.model
                    ? readableModelName(displayed.model)
                    : t('Escolher modelo', 'Choose model')
            }
            disabled={locked || closed || mutation.busy || !catalog}
            options={[
              ...(choice.executionMode === 'copilot'
                ? [
                    {
                      id: 'fusion',
                      label: 'Fusion',
                      group: t('Encaminhamento', 'Routing'),
                      description: tiers.some((tier) => tier.enabled)
                        ? t(
                            'O Copilot seleciona os modelos para a tarefa.',
                            'Copilot selects models for the task.',
                          )
                        : (tiers.find((tier) => tier.reason)?.reason ??
                          t(
                            'Fusion indisponível neste projeto/runtime.',
                            'Fusion unavailable for this project/runtime.',
                          )),
                      disabled: !tiers.some((tier) => tier.enabled),
                    },
                  ]
                : []),
              ...models
                .filter(
                  (model) =>
                    model.id !== 'fusion' &&
                    !model.fusion &&
                    (choice.executionMode === 'local' || model.id !== AGENT_MODEL_AUTO),
                )
                .map((model) => ({
                  id: model.id,
                  label: modelLabel(model, locale),
                  group: t('Modelos individuais', 'Individual models'),
                })),
            ]}
            onChange={(model) =>
              remember({
                ...choice,
                model,
                fusionTier:
                  model === 'fusion'
                    ? ((initialTier ?? tiers.find((tier) => tier.enabled))?.fusionTier ?? null)
                    : null,
                reasoningEffort: null,
              })
            }
          />
          <TeamPicker
            label={
              displayedFusion
                ? t('Nível Fusion', 'Fusion tier')
                : t('Esforço de raciocínio', 'Reasoning effort')
            }
            value={
              displayedFusion
                ? (displayed.fusionTier ?? '')
                : (displayed.reasoningEffort ?? 'standard')
            }
            display={
              displayedFusion
                ? tierLabel
                : displayed.reasoningEffort
                  ? readableModelName(displayed.reasoningEffort)
                  : 'Standard'
            }
            disabled={
              locked ||
              closed ||
              mutation.busy ||
              (!displayedFusion && !displayedModel?.efforts.length)
            }
            options={
              displayedFusion
                ? tiers.map((tier) => ({
                    id: tier.fusionTier!,
                    label: tier.name,
                    description: tier.enabled
                      ? tier.description
                      : (tier.reason ?? t('Indisponível', 'Unavailable')),
                    disabled: !tier.enabled,
                  }))
                : [
                    {
                      id: 'standard',
                      label: 'Standard',
                      description: t('Esforço predefinido do modelo.', 'Model default effort.'),
                    },
                    ...(displayedModel?.efforts ?? [])
                      .filter((effort) => effort !== 'standard')
                      .map((effort) => ({
                        id: effort,
                        label: readableModelName(effort),
                      })),
                  ]
            }
            onChange={(value) =>
              remember(
                displayedFusion
                  ? {
                      ...choice,
                      fusionTier: value as FusionTier,
                      reasoningEffort: null,
                    }
                  : {
                      ...choice,
                      fusionTier: null,
                      reasoningEffort: value === 'standard' ? null : value,
                    },
              )
            }
          />
          <span className="team-copilot-actions">
            {active && !active.cancelRequested && (
              <button type="button" className="button button-secondary" onClick={cancel}>
                {t('Parar', 'Stop')}
              </button>
            )}
            <button
              className="button button-primary"
              type="submit"
              disabled={blocked || (!active && !valid) || (running && !text.trim())}
            >
              {running ? t('Enviar', 'Send') : t('Investigar', 'Investigate')}
              <Icon name="arrow" size={16} />
            </button>
          </span>
        </div>
        {promo && displayedFusion && (
          <span className="field-hint team-fusion-promo">
            {promo.message ||
              t(
                `Promoção Fusion: ${promo.discountPercent}% de desconto.`,
                `Fusion promotion: ${promo.discountPercent}% discount.`,
              )}
          </span>
        )}
        {!catalog && (
          <span className="field-hint">{t('A carregar modelos…', 'Loading models…')}</span>
        )}
        {catalog?.refreshing && (
          <span className="field-hint">{t('A atualizar modelos…', 'Updating models…')}</span>
        )}
        {catalog?.errorCode && (
          <span className="field-hint">
            {t(
              'Catálogo desatualizado ou indisponível. Confirme a seleção antes de investigar.',
              'Catalog stale or unavailable. Confirm the selection before investigating.',
            )}
          </span>
        )}
        {!active && catalog && !valid && (
          <Notice tone="warning">
            {fusion
              ? (selectedTier?.reason ??
                t(
                  'Fusion ou nível indisponível. Escolha explicitamente outra opção.',
                  'Fusion or tier unavailable. Explicitly select another option.',
                ))
              : t(
                  'A preferência guardada está indisponível. Escolha explicitamente outro modelo ou esforço.',
                  'The saved preference is unavailable. Explicitly select another model or effort.',
                )}
          </Notice>
        )}
        <span className="field-hint">
          {t(
            'Copilot e Local executam no servidor ZeroOps através da conta Copilot; Local não é offline nem gratuito.',
            'Copilot and Local run on the ZeroOps server through the Copilot account; Local is not offline or free.',
          )}
        </span>
        <span className="field-hint">{hint}</span>
      </fieldset>
    </form>
  );
}
