# P04 — publicação e teste em QA

Catálogo de agentes/skills e compilação para Copilot. Pressupõe P00 a P03 em QA
(ver [qa-p03.md](qa-p03.md)). Os resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação em `/opt/zeroops/src`.
   Confirmar o SHA em `deploy/qa/VERSION` e em `/api/health`.
2. **Drenagem.** Não pode haver `agent_runs` nem `flow_assistant_requests` em
   `queued`/`running`. Os runs anteriores a P04 não têm
   `capability_manifest` e continuam a executar como antes.
3. **Backup.** Fazer um backup independente em
   `/var/backups/zeroops/pre-p04-*.sql.gz` e validá-lo com `gzip -t`. Este
   backup é adicional ao do script de deploy.
4. **Publicação.** Publicar por fast-forward de `main` no remoto `qa`
   (`git push qa feat/p04-capability-catalog:main`). O `post-receive` faz
   backup, migrate, compose, health e, se necessário, rollback. Não correr o
   script manualmente a seguir, para evitar um deploy duplicado.

## Migration

[037](../sql/037_capability_catalog.sql), aditiva e idempotente:

- tabelas `zeroops_skills`, `zeroops_skill_versions`,
  `zeroops_skill_version_files`, `zeroops_skill_bindings` e
  `zeroops_capability_shares`;
- coluna `provenance` em `zeroops_agent_profile_versions`;
- colunas `capability_manifest` e `capability_manifest_hash` em
  `agent_runs`.

Não há configuração nova. A permissão `skills.manage` é delegável pela página
de permissões do projeto (P01).

## Verificação técnica

```sql
SELECT name, checksum FROM zeroops_migrations WHERE name LIKE '037%';
SHOW TABLES LIKE 'zeroops_skill%';
SHOW COLUMNS FROM agent_runs LIKE 'capability_manifest%';
```

## Smoke funcional

Usar só recursos de teste e não alterar os fluxos reais do cliente.

1. **Catálogo.** Em `#capabilities`, importar por upload uma skill de teste
   com `SKILL.md` e `references/*.md`. Confirmar a versão 1, o hash, os
   ficheiros e a origem «upload». Importar de novo o mesmo nome devolve 409
   (`SKILL_NAME_EXISTS`); enviar o mesmo conteúdo como nova versão
   (`/skills/:id/versions`) é idempotente e mantém a v1. Um `SKILL.md` com
   `allowed-tools` (mesmo com aspas) é recusado com 422.
2. **Especialista.** Importar um `.agent.md` de teste, só de leitura, que é
   o especialista.
3. **Fluxo isolado.** Criar um fluxo de teste («Teste P04») cuja regra só
   corresponda a uma combinação sem tickets reais. Na etapa de agente,
   escolher a skill, o especialista e a concorrência 1. Ativar e confirmar
   no manifesto as versões e os hashes.
4. **Run real.** Criar um ticket de teste com essa combinação e deixar
   correr o run automático da etapa. Esperar:
   - `capability_manifest_hash` gravado;
   - eventos `capability`: `skill` invocada e `specialist`
     `started`/`completed`;
   - nenhuma recusa da guarda;
   - o run `succeeded`.
5. **Fixação.** Publicar a v2 da skill e confirmar que o run anterior mantém
   a v1 (o hash do manifesto não muda).
6. **Limpeza.** Fechar o ticket de teste (o fluxo de teste termina-o) e
   retirar o fluxo de teste do encaminhamento sem tocar nos restantes. Não
   há arquivo de fluxos: mudar a regra para uma combinação impossível em
   tickets novos (ambiente `development`) e ativar essa versão.

## Recuperação

- Se o health falhar, o hook repõe o commit anterior. Confirmar com
  `/api/health` e `deploy/qa/VERSION`.
- O rollback de código não desfaz a 037. As tabelas e colunas novas são
  ignoradas pelo código anterior.
- Antes de repor código anterior, drenar os runs com capacidades. O código
  anterior ignora o `capability_manifest` e executaria o perfil sem as
  skills.
- Para repor os dados, usar o backup `pre-p04-*` (operação destrutiva:
  pedir aprovação explícita).
