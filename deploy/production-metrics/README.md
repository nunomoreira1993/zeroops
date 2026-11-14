# Métricas de Produção (Prometheus em modo agente)

Envia as métricas do servidor de Produção para o Prometheus do ZeroOps (QA), para a página
**Saúde** e as regras do Alertmanager usarem dados reais de Produção (`env="production"`).

A rede só permite ligações **Produção → ZeroOps (HTTPS)**, por isso o envio é feito por _push_:

```
node_exporter :9100 ┐
mysqld_exporter :9104├─ Prometheus (modo agente, :9090) ── remote write HTTPS ──▶
redis_exporter :9121 ┘        só 127.0.0.1                 tickets.pizzahut.pt/api/monitoring/remote-write
                                                            (token zoh_ do agente de Saúde)
                                                                   │
                                                                   ▼
                                               Prometheus do ZeroOps (--web.enable-remote-write-receiver)
```

- Tudo escuta só em `127.0.0.1`. Os serviços correm com o utilizador `zeroops-metrics` (sem
  privilégios), com `Nice=19`, I/O idle e limites de CPU e memória: 64M por exporter e 160M no
  agente.
- Só são enviadas as séries usadas pelas verificações e pelas regras (`write_relabel_configs`),
  em lotes de 30 s.
- O utilizador MySQL `zeroops_exporter@localhost` só tem `PROCESS, REPLICATION CLIENT` e no
  máximo 3 ligações. Não lê dados do site.
- Os binários vêm dos releases oficiais no GitHub, com sha256 fixado no `install.sh`.

## Instalar ou atualizar

Requer o agente de Saúde já instalado (`/etc/zeroops-health`): o destino, a CA e o token vêm de lá.

```sh
scp -r deploy/production-metrics pizzahut-analise:/tmp/zeroops-metrics
ssh pizzahut-analise 'sudo sh /tmp/zeroops-metrics/install.sh'
```

O script é idempotente. Só reinstala binários quando o sha256 muda e só cria o utilizador MySQL
na primeira execução. Antes de alterar seja o que for, aborta se:

- houver menos de 1 GB de memória disponível;
- alguma das portas já estiver em uso por outro serviço;
- faltar o token ou a CA.

Ao atualizar, manter os argumentos do papel e o filtro PHP já instalado (consultar apenas
`ROLE` e `FPM_VERSIONS` no `collect.env`, sem expor credenciais). Na Pizza Hut `.110`:

```sh
sudo sh /tmp/zeroops-metrics/install.sh --role db --fpm-versions '^8[.]5'
```

Uma alteração apenas ao filtro de remote write requer atualizar o agente no `.110`; não é
necessário reinstalar os exporters do `.112`/`.109`. Confirmar no Prometheus de QA, com
`env="production"`, as séries `node_netstat_Tcp_CurrEstab`,
`node_network_receive_errs_total` e `node_filesystem_device_error`.

O Prometheus não tem equivalente ao `curl --resolve`. Por isso, o instalador acrescenta ao
`/etc/hosts` a linha `192.168.90.79 tickets.pizzahut.pt # zeroops-metrics`, retirada do
`ZEROOPS_RESOLVE`.

| Ficheiro                                    | Conteúdo                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/opt/zeroops-metrics/bin/`                 | Binários (`node_exporter`, `mysqld_exporter`, `redis_exporter`, `prometheus`, `promtool`). |
| `/etc/zeroops-metrics/prometheus-agent.yml` | Configuração gerada a partir de `prometheus-agent.yml`.                                    |
| `/etc/zeroops-metrics/token`                | Cópia do token `zoh_` do agente de Saúde (640).                                            |
| `/etc/zeroops-metrics/mysqld-exporter.cnf`  | Credenciais do `zeroops_exporter` (640).                                                   |
| `/etc/zeroops-metrics/redis-exporter.env`   | `REDIS_PASSWORD` lida do `redis.conf` (640).                                               |
| `/var/lib/zeroops-metrics/agent`            | WAL do envio (retenção máxima de 6 h se o ZeroOps estiver em baixo).                       |

Depois de **rodar o token do agente de Saúde**, voltar a correr o `install.sh`: copia o token novo
e reinicia o agente.

## Papéis e gráficos da Saúde

A tab **Saúde → Gráficos** usa estas métricas. Cada servidor de Produção instala-se com o seu
papel; só o servidor `db` tem o agente que envia para o ZeroOps.

| Servidor                             | Papel      | O que recolhe                                                        |
| ------------------------------------ | ---------- | -------------------------------------------------------------------- |
| `uqphorders22-db` (172.16.1.110)     | `db`       | node, MySQL, Redis, PHP-FPM, DB2/IBM i (DSN `PROD`) e envia tudo     |
| `uqphorders21-web` (172.16.1.112)    | `frontend` | node, workers Apache (`server-status` em `127.0.0.1:8088`) e PHP-FPM |
| `uqphorders23-static` (172.16.1.109) | `static`   | node e ligações nginx (`stub_status` em `127.0.0.1:8088`)            |

```sh
# No .110 (papel por omissão):
sudo sh install.sh
# No .112 e no .109, só acessíveis a partir do agente:
sudo sh install.sh --role frontend --agent-ip 172.16.1.110
sudo sh install.sh --role static --agent-ip 172.16.1.110
```

Nos papéis `frontend` e `static`, o `node_exporter` escuta no IP privado com
`IPAddressAllow=localhost <ip-próprio> <agent-ip>` (systemd), e o instalador mostra a entrada a acrescentar no
`.110`, em `/etc/zeroops-metrics/remote-nodes.yml` (lido pelo agente sem reinício):

```yaml
- targets: ['172.16.1.112:9100']
  labels: { instance: uqphorders21-web, role: frontend }
- targets: ['172.16.1.109:9100']
  labels: { instance: uqphorders23-static, role: static }
```

O `.109` tem firewall iptables própria (`/etc/iptables/iptables.conf`, que inclui
`/etc/iptables/rules/server`). A porta 9100 foi aberta só para o agente, ao lado da regra do Icinga:

```sh
# /etc/iptables/rules/server
iptables -A INPUT -i $IF -p tcp --dport 9100 -s 172.16.1.110 -j ACCEPT
```

O `zeroops-collect.timer` corre o `zeroops-collect.py` a cada 30 s e escreve as séries
`zeroops_*` (Apache, PHP-FPM, nginx, ping e tamanho do MySQL, DB2) para o _textfile collector_ do
`node_exporter`. Só faz leituras: o estado do DB2 vem de `QSYS2.SYSTEM_STATUS_INFO_BASIC` com as
credenciais do DSN existente.

`zeroops_db2_up` depende só da ligação ODBC e do `SELECT 1 FROM SYSIBM.SYSDUMMY1`. O
`zeroops-db2.php` imprime uma linha JSON logo após o ping e outra no fim com as estatísticas. Se as
estatísticas excederem o timeout, o coletor usa a primeira linha, por isso a lentidão das estatísticas
não gera um falso `Db2Indisponivel`. Não usar a vista completa `SYSTEM_STATUS_INFO`: demora 10–25 s
(cerca de 31 mil jobs), contra cerca de 1 s da vista `_BASIC`.

### DTQ de clientes (login)

No papel `db`, o coletor mede o DTQ users (`/api/v1/dtq/users/`), que serve o login e as moradas:

- **Sonda ativa** (`zeroops-dtq.php`, a cada 5 min): chama o endpoint real do site em
  `https://backend.pizzahut.pt` resolvido para `127.0.0.1` (Apache e PHP-FPM do site), com as
  credenciais da API interna em `lib/rest-api/config.json` e a conta de testes. Só consulta; nunca
  usa o DTQ de encomendas. Publica `zeroops_dtq_users_up` e `zeroops_dtq_users_seconds`. A chamada
  direta por PDO no PHP CLI não é usada porque o `CMDDATA` chega vazio fora do PHP-FPM.
- **Medição passiva** (`DTQ_LOG` no `collect.env`, escrito pelo instalador quando o ficheiro
  existe): lê o `log/dtq/dtq.log` de forma incremental (inode e offset em
  `/var/lib/zeroops-metrics/cache/dtq-log.json`; começa no fim do ficheiro e recomeça do início
  após o `copytruncate` do logrotate; no máximo 32 MB por execução). Publica
  `zeroops_dtq_requests_total{dtq}` (linhas `R`), `zeroops_dtq_responses_total{dtq}` (linhas `O`)
  e `zeroops_dtq_log_errors_total` (linhas `L ... [ERROR]`). As falhas do login são os pedidos
  `ULTPEDTQR2_31720` sem resposta (normal: cerca de 0,1%).
- **Paragem noturna do IBM i** (01:00–07:00, todos os dias): tudo se define no projeto, em
  **Saúde → Configuração → Paragens planeadas** (`quietWindows` em `health_settings`: horário, fuso,
  dias da semana e alvos). Os alvos podem ser verificações do worker, regras do Prometheus
  (`rule:<alerta>`) e sondas dos coletores (`probe:dtq`).
  - O coletor lê as paragens da sonda ao ZeroOps (`POST /api/monitoring/agent-config` com o token
    do agente; `ZEROOPS_URL` no `collect.env`, cache de 5 min em `cache/agent-config.json`). Na
    janela publica `zeroops_dtq_probe_paused 1` e não chama o site (que, de outra forma, enviaria o
    seu e-mail de falha do DTQ). `DTQ_PROBE_PAUSE=00:30-07:30` só vale se o ZeroOps nunca tiver
    respondido.
  - Alertas do Prometheus com alvo `rule:` são recebidos mas ficam silenciados no ZeroOps (sem
    e-mail nem ticket); se continuarem ativos no fim da janela, são notificados nessa altura.
  - As regras (ativa, limiar, duração e criticidade) também são administráveis por projeto, em
    **Saúde → Configuração → Regras de alerta**; o ZeroOps gera os ficheiros do Prometheus.

A conta de testes fica em `/etc/zeroops-metrics/dtq-probe.env` (`0640 root:zeroops-metrics`;
o instalador não o reescreve). Sem este ficheiro, a sonda fica desligada:

```sh
DTQ_PROBE_PHONE=9XXXXXXXX
DTQ_PROBE_STREET='RUA ...'
DTQ_PROBE_DOOR=...
DTQ_PROBE_POSTAL_CODE=XXXX-XXX
DTQ_PROBE_POSTAL_LOCATION='...'
DTQ_PROBE_LOCALITY='...'
```

Os valores têm de coincidir com uma morada da conta no DB2 (`$$CLI00001/MORLOJA`). Regras do
catálogo do ZeroOps (`packages/contracts/src/alert-rules.ts`, grupo `ibm_i`), ajustáveis por
projeto em Saúde > Regras de alerta: `Db2Indisponivel`, `Db2Lento`,
`Db2JobsElevados`, `Db2ArmazenamentoElevado`, `Db2MetricasAusentes`, `DtqClientesIndisponivel`,
`DtqClientesLento`, `DtqClientesTaxaFalhas` (mais de 5% e pelo menos 10 falhas em 10 min) e
`DtqErrosNoLog`.

- O Apache ganha um `VirtualHost 127.0.0.1:8088` só com `server-status`; o vhost por omissão
  devolvia 503 em `127.0.0.1`. É validado com `apache2ctl configtest` antes do _reload_.
- Só entram os pools PHP-FPM cujo socket é usado pelos vhosts ativos (`sites-enabled`); com
  `--fpm-versions '^8\.5'` (`FPM_VERSIONS` no `collect.env`) ficam só as versões pedidas. Em
  Produção, a Pizza Hut usa o PHP-FPM 8.5.12; o 7.4-cve2026 serve apenas o `pizzamovil.es`.
- Os pools sem `pm.status_path` (8.5) não são alterados nem recarregados: os workers são lidos em
  `/proc` (livres = bloqueados em `accept`) e a fila no Recv-Q do socket (`ss -xlH`). Os pools com
  `/fpm-status` usam-no.
- O ZeroOps guarda médias, máximos e p95 horários em `health_metric_hourly` (13 meses), base do
  intervalo de 13 meses e do mapa de calor; o Prometheus do QA guarda o detalhe 95 dias.

Os gráficos abrem no período **Todo o histórico**, desde a primeira amostra ainda retida no
Prometheus do ambiente/servidor escolhido. A data de início aparece em hora de Lisboa; cada
métrica mantém a sua própria cobertura e os intervalos sem medições ficam vazios. Este período
não compara com um período anterior à recolha. Os filtros de 1 hora a 90 dias e os agregados de
13 meses continuam disponíveis. O histórico é consultado diretamente: não requer migração nem
cópia de dados para a base de dados do ZeroOps.

## Verificar

```sh
systemctl status 'zeroops-*'
curl -s 127.0.0.1:9090/metrics | grep -E 'prometheus_remote_storage_(samples_total|samples_failed_total)'
```

No QA, `up{env="production"}` deve devolver os jobs `node`, `mysql` e `redis`. A integração
**Métricas** do ambiente Produção aponta para o Prometheus do ZeroOps com o matcher
`env="production"`:

```sh
docker compose exec -T api node dist/apps/api/src/ops.js metrics \
  --url http://127.0.0.1:9090 --matchers 'env="production"' --environment production --as <admin>
```

A regra `MetricasProducaoAusentes` avisa se deixarem de chegar métricas durante 10 minutos.
Entretanto, a Saúde usa o agente de Saúde como alternativa.

## Remover

```sh
sudo sh install.sh --remove
```

Para e remove os serviços, os binários, o WAL, o utilizador MySQL e a linha do `/etc/hosts`.
Mantém o `/etc/zeroops-metrics`.
