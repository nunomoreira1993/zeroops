import { isSiteKey, siteProfiles, type SiteKey } from '../../../../contracts/src/index.js';

const commonRules = `## Respostas
- A nota interna separa factos (com fonte e ambiente) de hipóteses.
- A resposta ao autor é em português de Portugal, sem dados pessoais nem dados de cartão.`;

const pizzaHut = `## Ambientes
- Produção (encomendar.pizzahut.pt, app e APIs) tem os dados reais: encomendas, pagamentos, faturas, clientes, lojas, produtos, preços e campanhas. Pedidos sobre casos concretos (cliente, encomenda, fatura, chargeback, loja) investigam-se em Produção: \`--env production\`.
- QA (Qualidade) só tem dados de teste e o código em validação. Usa QA apenas para reproduzir comportamentos, validar correções ou quando o pedido refere QA/testes.
- Se não for claro em que ambiente procurar, pergunta à equipa antes de consultar.
- Indica sempre o ambiente de cada facto na nota interna e nas evidências.

## Base de dados do site (\`pizzahut\`)
- Encomendas: \`encomendas\`, \`linhasencomenda\`, \`encomendas_log\`, \`encomendas_integradas\` (integração no POS).
- Pagamentos Shift4 (antiga Finaro/Credorax: cartão, Apple Pay, Google Pay, 3DS): \`encomendas_shift4\`, \`shift4_notifications\`, \`shift4_log\`, \`shift4_3dsecure\`, \`shift4_chargeback\`.
- MEO Wallet / MB WAY / Multibanco: \`encomendas_wallet\`, \`encomendas_wallet_log\`, \`encomendas_mbway_sibs\`.
- Lojas: \`uqlojas\` (inclui o centro de custo), \`lojas_shift4\`, \`lojas_wallet\`. Clientes: \`clientes\`.
- As tabelas com sufixo de ano (ex.: \`encomendas_2026\`, \`shift4_log_2026\`) são arquivos anuais: se não encontrares na tabela principal, procura no arquivo do ano em causa.
- Começa por DESCRIBE para confirmar as colunas e filtra sempre por chaves ou datas, com LIMIT.

## Logs da aplicação (Produção)
- \`zo-log --env production <tipo> "texto"\`: api, api-public, dtq, php_errors, oreo, db2-trace, db2_log, moradas, loyalty, wallet, rest_log, sdr, database-health.
- Por omissão lê só o ficheiro atual; usa o argumento de dias para incluir os ficheiros rodados.

## DB2/IBM i e filas DTQ (login dos clientes)
- O login e as moradas dos clientes passam pelo DTQ users (\`/api/v1/dtq/users/\`: ULTPEDTOS2_161 envia, ULTPEDTQR2_31720 lê a resposta no DB2). Queixas de "não consigo entrar" ou "morada não encontrada" verificam-se primeiro aqui.
- Métricas de Produção (\`zo-prom\`): \`zeroops_dtq_users_up\` e \`zeroops_dtq_users_seconds\` (sonda com a conta de testes a cada 5 min); \`zeroops_dtq_requests_total{dtq=...}\` e \`zeroops_dtq_responses_total{dtq=...}\` (pedidos e respostas do site no dtq.log; falhas = pedidos − respostas, normal ~0,1%); \`zeroops_dtq_log_errors_total\`; DB2 em \`zeroops_db2_up\`, \`zeroops_db2_connect_seconds\`, \`zeroops_db2_query_seconds\`, jobs e ASP.
- Exemplo: \`zo-prom 'sum(increase(zeroops_dtq_requests_total{dtq="ULTPEDTQR2_31720"}[1h])) - sum(increase(zeroops_dtq_responses_total{dtq="ULTPEDTQR2_31720"}[1h]))' 6h\`.
- Para o detalhe de um caso usa \`zo-log --env production dtq "<telefone ou hora>"\` e \`db2_log\`. Nunca chames o DTQ de encomendas nem cries pedidos de teste.

${commonRules}`;

const pizzaMovil = `## Plataforma
- Pizza Movil (Espanha): site www.pizzamovil.es, com o mesmo núcleo de código da Pizza Hut mas base de dados, lojas e clientes próprios. Os dados de clientes e encomendas estão em espanhol.

## Ambientes
- Produção (www.pizzamovil.es) tem os dados reais. Pedidos sobre casos concretos (cliente, encomenda, pagamento, chargeback, loja) investigam-se em Produção: \`--env production\`.
- QA (dev.pizzamovil.es) só tem dados de teste e o código em validação. Usa QA apenas para reproduzir comportamentos, validar correções ou quando o pedido refere QA/testes.
- Se não for claro em que ambiente procurar, pergunta à equipa antes de consultar.
- Indica sempre o ambiente de cada facto na nota interna e nas evidências.

## Base de dados do site (\`pizzamovil\`)
- Encomendas: \`encomendas\`, \`encomendas_log\`, \`encomendas_integradas\` (integração no POS), \`encomendas_slots\`, \`encomendas_gestao\`.
- Pagamentos Shift4 (antiga Finaro/Credorax: cartão, Apple Pay, Google Pay, 3DS): \`encomendas_shift4\`, \`shift4_notifications\`, \`shift4_notifications_gpay\`, \`shift4_log\`, \`shift4_3dsecure\`, \`shift4_chargeback\`.
- Outros pagamentos: \`encomendas_payline\`, \`encomendas_paypal\`, \`encomendas_mbway_sibs\`. Não existe MEO Wallet nesta plataforma.
- Lojas: \`lojas_shift4\`, \`lojas_shift4_companies\`, \`loja_config\`, \`loja_pagamento\`. Clientes: \`clientes\`.
- As tabelas com sufixo de ano (ex.: \`encomendas_2025\`) são arquivos anuais: se não encontrares na tabela principal, procura no arquivo do ano em causa.
- Começa por DESCRIBE para confirmar as colunas e filtra sempre por chaves ou datas, com LIMIT.

## Logs da aplicação (Produção)
- \`zo-log --env production <tipo> "texto"\`: dtq, loyalty, moradas, oreo.
- Os logs desta plataforma são diários (\`<tipo>/AAAA_MM_DD.txt\`): por omissão lê o ficheiro mais recente; usa o argumento de dias para incluir os dias anteriores.

${commonRules}`;

const generic = `## Ambientes
- Produção tem os dados reais; QA só tem dados de teste e o código em validação.
- Pedidos sobre casos concretos investigam-se em Produção (\`--env production\`); se não for claro o ambiente, pergunta à equipa antes de consultar.
- Indica sempre o ambiente de cada facto na nota interna e nas evidências.

## Base de dados
- Começa por SHOW TABLES/DESCRIBE para confirmar o esquema e filtra sempre por chaves ou datas, com LIMIT.

${commonRules}`;

const bySite: Record<SiteKey, string> = { pizzahut: pizzaHut, pizzamovil: pizzaMovil };

/** Instruções iniciais do agente para o site do projeto (genéricas quando não há site). */
export function defaultInstructionsForSite(siteKey: string | null | undefined) {
  return isSiteKey(siteKey) ? bySite[siteKey] : generic;
}

/** Nome da plataforma do site, para o prompt do agente. */
export function siteLabel(siteKey: string | null | undefined) {
  return isSiteKey(siteKey) ? siteProfiles[siteKey].label : null;
}
