import type { Capabilities } from '../../contracts/src/index.js';

export function unconfiguredCapabilities(): Capabilities {
  return {
    investigation: false,
    implementation: false,
    deployment: false,
    blockers: [
      'O gate global está em modo fail-closed e ainda não consome o estado das integrações por projeto.',
      'Este bloqueio de configuração do serviço não representa indisponibilidade da conta do utilizador.',
    ],
  };
}
