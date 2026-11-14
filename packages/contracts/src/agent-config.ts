import { z } from 'zod';

/** Ambientes onde o agente pode consultar dados (QA = testes, Produção = dados reais). */
export const agentEnvironments = ['quality', 'production'] as const;
export type AgentEnvironment = (typeof agentEnvironments)[number];

/** Tipos de log da aplicação disponíveis no relay de Produção (`httpdocs/log/<tipo>/<tipo>.log`). */
export const siteLogTypes = [
  'api',
  'api-public',
  'dtq',
  'php_errors',
  'oreo',
  'db2-trace',
  'db2_log',
  'moradas',
  'loyalty',
  'wallet',
  'rest_log',
  'sdr',
  'database-health',
] as const;
export type SiteLogType = (typeof siteLogTypes)[number];

/** Instruções do agente para o projeto; `version` 0 indica o texto por omissão (nunca gravado). */
export interface AgentInstructions {
  body: string;
  version: number;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  canManage: boolean;
  /** Perguntas do agente ao cliente enviadas sem revisão (opção do projeto). */
  autoClientQuestions: boolean;
  /** Investigação automática do Copilot em cada ticket novo (opção do projeto). */
  autoInvestigate: boolean;
  history: { version: number; createdAt: string; author: string | null }[];
}

export const agentInstructionsInputSchema = z.strictObject({
  body: z.string().trim().min(20).max(20000),
  expectedVersion: z.number().int().nonnegative(),
});

export const agentChannelSettingsSchema = z
  .strictObject({
    autoClientQuestions: z.boolean().optional(),
    autoInvestigate: z.boolean().optional(),
  })
  .refine(
    (value) => value.autoClientQuestions !== undefined || value.autoInvestigate !== undefined,
    {
      message: 'Indique pelo menos uma opção.',
    },
  );

/** Estado do relay de Produção do projeto (o token só é mostrado ao rodar). */
export interface ProductionRelayStatus {
  configured: boolean;
  online: boolean;
  hostname: string | null;
  version: string | null;
  lastSeenAt: string | null;
  rotatedAt: string | null;
  canManage: boolean;
  pending: number;
  lastDay: { done: number; failed: number; expired: number };
}

export const relayPollSchema = z.strictObject({
  hostname: z.string().trim().max(255).optional(),
  version: z.string().trim().max(40).optional(),
  /** Ferramentas configuradas no servidor (relays anteriores a 1.1.0 não enviam: sql e log). */
  tools: z
    .array(z.string().regex(/^[a-z0-9]{1,16}$/))
    .max(12)
    .optional(),
});

export const relayResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    code: z.string().trim().min(1).max(60),
    message: z.string().trim().max(500),
  }),
]);
