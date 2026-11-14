import { useState } from 'react';
import type { IncidentDemoScenario } from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { TechLogo } from '../flows/tech-logos';

const scenarios: {
  id: IncidentDemoScenario;
  icon: string;
  title: { pt: string; en: string };
  detail: { pt: string; en: string };
}[] = [
  {
    id: 'disk',
    icon: 'disk',
    title: { pt: 'Disco cheio', en: 'Disk full' },
    detail: {
      pt: '/var a 97% com ficheiros apagados ainda abertos pelo php-fpm.',
      en: '/var at 97% with deleted files still held by php-fpm.',
    },
  },
  {
    id: 'memory',
    icon: 'memory',
    title: { pt: 'Pressão de memória', en: 'Memory pressure' },
    detail: {
      pt: 'Memória disponível abaixo de 5%, com o php-fpm a ocupar 80%.',
      en: 'Available memory below 5%, php-fpm using 80%.',
    },
  },
  {
    id: 'mysql',
    icon: 'mysql',
    title: { pt: 'Site sem MySQL', en: 'Site without MySQL' },
    detail: {
      pt: 'O alerta vem do site; a causa está no MySQL (outro componente).',
      en: 'The site raises the alert; the cause is MySQL (another component).',
    },
  },
  {
    id: 'db2',
    icon: 'db2',
    title: { pt: 'Site sem DB2', en: 'Site without DB2' },
    detail: {
      pt: 'A causa está no DB2, que não gerimos: a intervenção é recusada e escala.',
      en: 'The cause is DB2, which we do not manage: intervention is refused and escalated.',
    },
  },
];

/**
 * Demonstração do fluxo «Incidente (Health)»: injeta um alerta sintético no QA, que segue o
 * percurso real (investigação, decisão, validação e e-mail) com as intervenções simuladas.
 */
export function HealthIncidentDemo() {
  const { request } = useSession();
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const mutation = useMutation();
  const [opened, setOpened] = useState<{
    scenario: IncidentDemoScenario;
    ticketId: string | null;
  } | null>(null);

  const start = (scenario: IncidentDemoScenario) =>
    void mutation.run(async () => {
      setOpened(
        await request<{ scenario: IncidentDemoScenario; ticketId: string | null }>(
          '/monitoring/incident-demo',
          { method: 'POST', body: { scenario } },
        ),
      );
    });

  return (
    <section className="panel health-settings health-policy" data-testid="incident-demo">
      <div className="section-heading">
        <div>
          <h2>{t('Demonstração do fluxo de incidente', 'Incident flow demo')}</h2>
          <p className="health-muted">
            {t(
              'Abre um incidente no QA a partir de um alerta sintético. O fluxo corre como num caso real, mas as intervenções são apenas simuladas e nenhum servidor é alterado.',
              'Opens a QA incident from a synthetic alert. The flow runs as in a real case, but interventions are only simulated and no server is changed.',
            )}
          </p>
        </div>
      </div>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {opened && (
        <Notice tone="success">
          {t('Incidente de demonstração aberto.', 'Demo incident opened.')}{' '}
          {opened.ticketId && (
            <a href={`#tickets/${opened.ticketId}`}>{t('Abrir o ticket', 'Open the ticket')}</a>
          )}
        </Notice>
      )}
      <div className="health-demo-grid">
        {scenarios.map((item) => (
          <button
            key={item.id}
            type="button"
            className="health-demo-card"
            disabled={mutation.busy}
            onClick={() => start(item.id)}
          >
            <TechLogo id={item.icon} size={22} />
            <strong>{item.title[lang]}</strong>
            <span className="health-muted">{item.detail[lang]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
