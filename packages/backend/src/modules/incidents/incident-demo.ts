import { randomBytes } from 'node:crypto';
import {
  incidentDemoScenarios,
  type IncidentDemoScenario,
} from '../../../../contracts/src/index.js';

interface DemoAlert {
  alertname: string;
  title: string;
  summary: string;
  labels: Record<string, string>;
}

/**
 * Alertas sintéticos dos cenários de demonstração. Seguem pelo recetor real do Alertmanager, com
 * `env=quality` e a label `zeroops_demo`, que marca o incidente: as intervenções são simuladas.
 */
const DEMO_ALERTS: Record<IncidentDemoScenario, DemoAlert> = {
  disk: {
    alertname: 'DiskAlmostFull',
    title: 'Disco quase cheio',
    summary:
      'O volume /var em web01 está a 97%. Há ficheiros temporários apagados ainda abertos pelo php-fpm.',
    labels: {
      instance: 'web01',
      mountpoint: '/var',
      unit: 'php-fpm.service',
      component: 'disco /var (web01)',
    },
  },
  memory: {
    alertname: 'HighMemoryPressure',
    title: 'Pressão de memória',
    summary:
      'A memória disponível em web01 está abaixo de 5% e o swap a crescer; o php-fpm ocupa 80%.',
    labels: { instance: 'web01', unit: 'php-fpm.service', component: 'memória (web01)' },
  },
  mysql: {
    alertname: 'SiteDatabaseConnectionFailed',
    title: 'Falha de ligação à base de dados no site',
    summary: 'O site devolve 500: SQLSTATE[HY000] [1040] Too many connections.',
    labels: { instance: 'web01', component: 'site pizzahut (web01)' },
  },
  db2: {
    alertname: 'SiteDatabaseConnectionFailed',
    title: 'Falha de ligação à base de dados no site',
    summary: 'Os pagamentos falham: SQL30081N, ligação ao DB2 recusada.',
    labels: { instance: 'web01', component: 'site pizzahut (web01)' },
  },
};

export const isIncidentDemoScenario = (value: unknown): value is IncidentDemoScenario =>
  typeof value === 'string' && (incidentDemoScenarios as readonly string[]).includes(value);

/** Cenário de demonstração declarado nas labels do alerta (null nos alertas reais). */
export const demoScenarioOf = (labels: Record<string, string>) =>
  isIncidentDemoScenario(labels.zeroops_demo) ? labels.zeroops_demo : null;

/** Payload do Alertmanager (webhook v4) para um cenário; cada pedido gera um alerta novo. */
export function incidentDemoPayload(scenario: IncidentDemoScenario, now = new Date()) {
  const alert = DEMO_ALERTS[scenario];
  return {
    alerts: [
      {
        status: 'firing' as const,
        labels: {
          ...alert.labels,
          alertname: alert.alertname,
          severity: 'critical',
          env: 'quality',
          zeroops_demo: scenario,
        },
        annotations: { title: `${alert.title} (demonstração)`, summary: alert.summary },
        startsAt: now.toISOString(),
        fingerprint: randomBytes(8).toString('hex'),
      },
    ],
  };
}
