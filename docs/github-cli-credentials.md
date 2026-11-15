# Credenciais GitHub CLI no ZeroOps

O fornecedor `github_cli` permite importar uma sessão autenticada do GitHub CLI para um
repositório Git de um projeto. O token é lido apenas por stdin, validado por chamadas GET à API
GitHub e por `git ls-remote`, e guardado cifrado com `IdentityCipher` e contexto do projeto e
repositório. O token não é devolvido pela API, escrito em argumentos/logs, nem disponibilizado ao
agente ou ao workspace. O executor usa a credencial apenas nas operações Git e de pull request já
vinculadas ao repositório.

## Importar numa instalação QA

1. Confirma que o destino é o ZeroOps QA e que a migration `046_github_cli_credentials.sql` foi
   aplicada.
2. No host QA, como `root`, autentica o GitHub CLI com uma configuração dedicada em tmpfs:

   ```bash
   install -d -m 700 /run/zeroops-gh-auth
   GH_CONFIG_DIR=/run/zeroops-gh-auth /opt/gh/2.104.0/bin/gh auth login --web --git-protocol https
   ```

   O CLI pode avisar que o seu ficheiro de configuração contém o token em texto simples. Esta
   configuração é temporária, restrita a `root` e em `/run`; não a copies para o checkout, imagem,
   workspace do agente ou logs.

3. Na pasta `/opt/zeroops/src/deploy/docker`, envia o token diretamente do CLI para o comando
   administrativo, sem o mostrar no terminal nem o passar em argumentos:

   ```bash
   GH_CONFIG_DIR=/run/zeroops-gh-auth /opt/gh/2.104.0/bin/gh auth token |
     docker compose --env-file /etc/zeroops/zeroops.env exec -T api \
       node dist/apps/api/src/ops.js github-cli-credential \
       --as admin@exemplo.pt \
       --project <PROJECT_UUID> \
       --repository-name "Pizza Hut website"
   ```

   O operador tem de ser administrador ativo e ter `repositories.manage` no projeto. O comando
   exige os scopes `repo`, `pull=true` e `push=true`, verifica a identidade e branch base, aplica
   allowlist/URL do projeto, faz controlo de concorrência pela versão e audita a identidade,
   scopes e permissões (nunca o token). Não executa operações de escrita no GitHub.

4. Confirma na página Repositórios Git que a credencial aparece como `GitHub CLI · <login>` e
   volta a usar «Verificar acesso». Essa verificação faz GET à API e `ls-remote`; HTTP 401 indica
   credencial revogada/expirada e HTTP 403 indica falta de autorização ou permissões.
5. Depois da importação validada, remove os dois ficheiros temporários da configuração para não
   manter a cópia plaintext:

   ```bash
   rm -f /run/zeroops-gh-auth/hosts.yml /run/zeroops-gh-auth/config.yml
   rmdir /run/zeroops-gh-auth
   ```

   Estes caminhos são específicos do diretório dedicado. Não uses `rm -rf`.

## Rotação e revogação

- Para reautenticar uma sessão expirada/revogada, repete os passos 2–3. O comando substitui a
  credencial cifrada e atualiza o login verificado.
- «Remover credencial» na UI apaga a cópia cifrada do ZeroOps, mas não revoga a autorização
  OAuth na conta GitHub. Para revogação efetiva, termina a sessão local do CLI e revoga a aplicação
  autorizada nas definições GitHub da conta/organização.
- O ZeroOps não conserva o `hosts.yml` nem usa a configuração global do host/runtime. Por isso,
  a renovação automática do token não está disponível: após expiração, é necessária nova
  autenticação interativa e importação.

## Âmbito e limitações

- Suporta `https://github.com/<owner>/<repo>`; GitHub Enterprise e remotos SSH ficam fora deste
  fornecedor.
- O repositório tem de estar dentro de `ZEROOPS_DEV_ALLOWED_REPO_ROOTS`.
- Uma sessão de conta pessoal pode ter scopes mais amplos do que o repositório associado. O
  binding limita onde o ZeroOps a usa, mas não reduz os privilégios intrínsecos do token. Prefere
  uma identidade de integração com acesso mínimo quando a política da organização o permitir.
