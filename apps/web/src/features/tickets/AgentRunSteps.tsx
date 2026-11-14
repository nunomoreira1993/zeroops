import type { StepItem, ToolStep } from './agent-run-timeline';
import { parseToolArguments, toolEnvironment } from './agent-run-timeline';
import { Icon } from '../../components/Icon';
import { useIdentityLocale } from '../../lib/identity';

type Translate = (pt: string, en: string) => string;

const permissionText: Record<string, [string, string]> = {
  shell: ['Comando', 'Command'],
  mcp: ['MCP', 'MCP'],
  read: ['Leitura', 'Read'],
  write: ['Escrita', 'Write'],
  url: ['URL', 'URL'],
};

function permissionLabel(kind: string, decision: 'approved' | 'denied', t: Translate) {
  const text = permissionText[kind];
  return `${text ? t(...text) : kind} ${decision === 'approved' ? t('permitido', 'allowed') : t('recusado', 'denied')}`;
}

/** Descrição curta e comando de uma ferramenta, para a linha recolhida. */
function describeTool(step: ToolStep) {
  const args = parseToolArguments(step.arguments);
  const description = typeof args?.description === 'string' ? args.description : null;
  const command =
    typeof args?.command === 'string'
      ? args.command
      : typeof args?.path === 'string'
        ? args.path
        : typeof args?.pattern === 'string'
          ? args.pattern
          : null;
  return { label: description ?? step.title ?? step.tool, command, args };
}

function prettyArguments(raw: string | null, args: Record<string, unknown> | null) {
  if (args) return JSON.stringify(args, null, 2);
  return raw;
}

function EnvBadge({ env }: { env: 'production' | 'quality' | null }) {
  const { t } = useIdentityLocale();
  if (!env) return null;
  return (
    <span className={`agent-env-badge${env === 'production' ? ' is-production' : ''}`}>
      {env === 'production' ? t('PRODUÇÃO', 'PRODUCTION') : 'QA'}
    </span>
  );
}

function StateIcon({ step }: { step: ToolStep }) {
  const { t } = useIdentityLocale();
  if (step.state === 'running')
    return <span className="spinner" aria-label={t('A executar', 'Running')} />;
  return (
    <span className={`agent-step-state agent-step-${step.state}`} aria-hidden="true">
      <Icon name={step.state === 'succeeded' ? 'check' : 'warning'} size={12} />
    </span>
  );
}

function ToolRow({ step }: { step: ToolStep }) {
  const { t } = useIdentityLocale();
  const { label, command, args } = describeTool(step);
  const env = toolEnvironment(step.arguments);
  const input = prettyArguments(step.arguments, args);
  return (
    <li className={`agent-step agent-step-tool-${step.state}`}>
      <details>
        <summary>
          <span className="agent-step-chevron" aria-hidden="true">
            <Icon name="chevron" size={12} />
          </span>
          <StateIcon step={step} />
          <EnvBadge env={env} />
          {step.server && <span className="agent-live-server">{step.server}</span>}
          <span className="agent-step-label">{label}</span>
          {command && command !== label && <code className="agent-step-command">{command}</code>}
          {step.state === 'failed' && (
            <span className="agent-step-flag">{t('falhou', 'failed')}</span>
          )}
        </summary>
        <div className="agent-step-body">
          <p className="agent-step-meta">
            <strong>{step.tool}</strong>
            {step.permission && (
              <> · {permissionLabel(step.permission.kind, step.permission.decision, t)}</>
            )}
          </p>
          {input && (
            <>
              <span className="agent-step-caption">{t('Entrada', 'Input')}</span>
              <pre>{input}</pre>
            </>
          )}
          {step.result && (
            <>
              <span className="agent-step-caption">
                {step.state === 'failed' ? t('Erro', 'Error') : t('Resultado', 'Result')}
              </span>
              <pre>{step.result}</pre>
            </>
          )}
        </div>
      </details>
    </li>
  );
}

function StepRow({ step }: { step: StepItem }) {
  const { t } = useIdentityLocale();
  switch (step.kind) {
    case 'tool':
      return <ToolRow step={step} />;
    case 'status':
      return <li className="agent-step agent-step-status">{step.text}</li>;
    case 'permission':
      return (
        <li
          className={`agent-step agent-step-permission agent-step-permission-${step.permission.decision}`}
        >
          {permissionLabel(step.permission.kind, step.permission.decision, t)}:{' '}
          <code>{step.permission.detail}</code>
        </li>
      );
  }
}

/**
 * Passos técnicos consecutivos do agente (intenções, ferramentas e permissões) num bloco
 * recolhido, como no VS Code: o resumo mostra o que está a acontecer e quantas consultas foram a
 * Produção; cada passo abre a entrada e o resultado.
 */
export function AgentRunSteps({ steps }: { steps: StepItem[] }) {
  const { t } = useIdentityLocale();
  const tools = steps.filter((step): step is ToolStep => step.kind === 'tool');
  const running = tools.find((step) => step.state === 'running');
  const failed = tools.filter((step) => step.state === 'failed').length;
  const denied = steps.filter(
    (step) =>
      (step.kind === 'permission' && step.permission.decision === 'denied') ||
      (step.kind === 'tool' && step.permission?.decision === 'denied'),
  ).length;
  const production = tools.filter(
    (step) => toolEnvironment(step.arguments) === 'production',
  ).length;
  const intent = [...steps].reverse().find((step) => step.kind === 'status');
  const title = running
    ? describeTool(running).label
    : (intent?.text ??
      `${tools.length} ${tools.length === 1 ? t('passo executado', 'step run') : t('passos executados', 'steps run')}`);
  return (
    <li className={`agent-steps${failed || denied ? ' agent-steps-warn' : ''}`}>
      <details>
        <summary>
          <span className="agent-step-chevron" aria-hidden="true">
            <Icon name="chevron" size={12} />
          </span>
          {running ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <Icon name="code" size={13} />
          )}
          <span className="agent-steps-title">{title}</span>
          <span className="agent-steps-meta">
            {tools.length}{' '}
            {tools.length === 1 ? t('ferramenta', 'tool') : t('ferramentas', 'tools')}
            {production > 0 && (
              <>
                {' '}
                · {production} {t('em Produção', 'in Production')}
              </>
            )}
            {failed > 0 && (
              <>
                {' '}
                · {failed} {failed === 1 ? t('falhou', 'failed') : t('falharam', 'failed')}
              </>
            )}
            {denied > 0 && (
              <>
                {' '}
                · {denied} {t(denied === 1 ? 'recusada' : 'recusadas', 'denied')}
              </>
            )}
          </span>
        </summary>
        <ol className="agent-steps-list">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </ol>
      </details>
    </li>
  );
}
