/**
 * Sites (plataformas) suportados pelo ZeroOps. Cada projeto pode estar ligado a um site, que define
 * o código-fonte disponível ao agente, as instruções por omissão e a instância do relay de Produção.
 */
export const siteKeys = ['pizzahut', 'pizzamovil'] as const;
export type SiteKey = (typeof siteKeys)[number];

export interface SiteProfile {
  key: SiteKey;
  /** Nome da plataforma, usado no prompt do agente e na administração. */
  label: string;
  productionUrl: string;
  qualityUrl: string;
  /** Base de dados do site (igual em QA e Produção). */
  database: string;
  /**
   * Valor da label `project` dos alvos do Prometheus deste site (`''` = sem label). O site com
   * `''` recebe também os alertas da infraestrutura partilhada (servidores, BD, IBM i).
   */
  alertProjectLabel: string;
}

export const siteProfiles: Record<SiteKey, SiteProfile> = {
  pizzahut: {
    key: 'pizzahut',
    label: 'Pizza Hut',
    productionUrl: 'https://encomendar.pizzahut.pt/',
    qualityUrl: 'https://devpizzahut.uq.pt/',
    database: 'pizzahut',
    alertProjectLabel: '',
  },
  pizzamovil: {
    key: 'pizzamovil',
    label: 'Pizza Movil',
    productionUrl: 'https://www.pizzamovil.es/es/',
    qualityUrl: 'https://dev.pizzamovil.es/',
    database: 'pizzamovil',
    alertProjectLabel: 'pizzamovil',
  },
};

export const isSiteKey = (value: unknown): value is SiteKey =>
  typeof value === 'string' && (siteKeys as readonly string[]).includes(value);
