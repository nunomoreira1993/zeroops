import type { Capabilities } from '../../contracts/src/index.js';

export function unconfiguredCapabilities(): Capabilities {
  return {
    investigation: false,
    implementation: false,
    deployment: false,
    blockers: [
      'Servidor, caminhos e isolamento de qualidade ainda nao validados.',
      'Identidade Copilot e politica de envio de contexto ainda nao confirmadas.',
      'Conectores de leitura e operador de producao ainda nao ativados.',
      'O portal permite triagem e propostas humanas; nao apresenta automacao simulada como real.',
    ],
  };
}
