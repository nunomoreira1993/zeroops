import {
  incidentReportInstruction,
  interventionActionLabels,
  recoveryCriterionFor,
  type FlowDefinition,
  type FlowNode,
} from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';
import { parseLabels } from '../health/health-incident-lifecycle.js';
import { IncidentPolicyRepository } from './incident-policy.repository.js';
import { describeResource, resourceFromAlert } from './incident-resource.js';

/**
 * Contexto do incidente para a etapa de investigação do Copilot: o recurso, o que o projeto
 * autoriza, o percurso seguinte do fluxo publicado e o formato do relatório que o motor lê.
 * Devolve null quando a etapa não pede o relatório de incidente.
 */
export async function incidentInstructionContext(
  client: Queryable,
  input: { ticketId: string; projectId: string; definition: FlowDefinition; node: FlowNode },
): Promise<string | null> {
  if (input.node.config.incidentReport !== true) return null;
  const policy = await new IncidentPolicyRepository(client).get(input.projectId, client);
  const row = (
    await client.query<{
      environment: 'quality' | 'production';
      root_title: string;
      resource_kind: string | null;
      resource_engine: string | null;
      resource_host: string | null;
      resource_unit: string | null;
      resource_managed: boolean;
      alert_name: string | null;
      labels: string | Record<string, string> | null;
      demo_scenario: string | null;
    }>(
      `SELECT h.environment,h.root_title,h.resource_kind,h.resource_engine,h.resource_host,h.resource_unit,
              h.resource_managed,h.demo_scenario,a.alert_name,a.labels
         FROM health_incidents h LEFT JOIN health_external_alerts a ON a.id=h.root_alert_id
        WHERE h.ticket_id=$1`,
      [input.ticketId],
    )
  ).rows[0];
  const parts: string[] = ['Fluxo «Incidente (Health)»: segue as etapas publicadas do projeto.'];
  if (row) {
    const resource = row.resource_kind
      ? {
          kind: row.resource_kind,
          engine: row.resource_engine,
          host: row.resource_host,
          unit: row.resource_unit,
          environment: row.environment,
          managed: Boolean(row.resource_managed),
        }
      : resourceFromAlert(
          row.alert_name ?? row.root_title,
          row.labels ? parseLabels(row.labels) : {},
          row.environment,
          policy,
        );
    parts.push(
      `Recurso do alerta: ${describeResource(resource)}; critério de recuperação: ${recoveryCriterionFor(resource)}.`,
    );
    if (row.demo_scenario)
      parts.push(
        `Cenário de demonstração «${row.demo_scenario}»: não há sistema real afetado; descreve o diagnóstico esperado e propõe a ação como se fosse real.`,
      );
  }
  const actions = policy.rules
    .filter((rule) => rule.decision !== 'forbidden')
    .map(
      (rule) =>
        `${interventionActionLabels[rule.action].pt} (${rule.decision === 'auto' ? 'automática' : 'com aprovação'}${rule.environment !== 'any' ? `, ${rule.environment}` : ''}${rule.kind !== 'any' ? `, ${rule.kind}` : ''})`,
    );
  parts.push(
    `Ações que o projeto autoriza: ${actions.length ? [...new Set(actions)].join('; ') : 'nenhuma'}. ` +
      `Serviços permitidos: ${policy.services.map((item) => item.unit).join(', ') || 'nenhum'}. ` +
      `Motores só de leitura: ${policy.unmanagedEngines.join(', ') || 'nenhum'}. ` +
      'Não executes alterações: só diagnóstico e leitura; o motor do fluxo executa a ação depois de a política a autorizar. Nunca apagues ficheiros nem dados.',
  );
  const next = input.definition.edges
    .filter((edge) => edge.source === input.node.id)
    .map((edge) => input.definition.nodes.find((node) => node.id === edge.target)?.label)
    .filter(Boolean);
  if (next.length) parts.push(`Etapas seguintes: ${next.join(', ')}.`);
  parts.push(incidentReportInstruction());
  return parts.join('\n');
}
