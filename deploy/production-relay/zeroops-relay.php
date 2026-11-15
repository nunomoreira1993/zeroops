<?php
/**
 * ZeroOps - relay de Produção (leitura e intervenções autorizadas).
 *
 * A rede só permite Produção -> ZeroOps (HTTPS), por isso este processo vai buscar as consultas
 * do agente ao ZeroOps (long-poll), executa-as localmente e devolve o resultado:
 *   - sql: uma instrução de leitura na BD do site, com o utilizador MySQL zeroops_agent (só SELECT),
 *          transação READ ONLY, max_statement_time e limite de linhas;
 *   - log: leitura de uma lista fechada de ficheiros de log da aplicação (sem shell);
 *   - restart/param/reboot: intervenções do fluxo de Incidente, via systemd, limitadas às unidades,
 *          propriedades e reboot autorizados em relay.env e recusadas se a Saúde estiver suspensa.
 *
 * Configuração (fora do código, ver README.md), numa pasta por instância (um site por instância):
 *   <pasta>/relay.env       ZEROOPS_URL, ZEROOPS_RESOLVE, ZEROOPS_CACERT, LOG_ROOT,
 *                           ZEROOPS_ENVIRONMENT, ALLOWED_UNITS, ALLOWED_PROPERTIES, ALLOW_REBOOT
 *   <pasta>/token.env       ZEROOPS_RELAY_TOKEN (gerado em Integrações > Agente do projeto)
 *   <pasta>/agent-mysql.cnf [client] user, password, socket, database
 *   <pasta>/agent-db2.ini   [db2] dsn, user, password (opcional: ativa a ferramenta db2, só leitura)
 * A pasta é o 1.º argumento, ou ZEROOPS_RELAY_CONFIG_DIR, ou /etc/zeroops-relay.
 */

declare(strict_types=1);

const RELAY_VERSION = '1.2.0';
/** Contrato das intervencoes (pedidos v2 trazem prazo e chave de idempotencia). */
const INTERVENTION_CONTRACT = 'zeroops.intervention/2';
/** Entradas do journal com mais de 7 dias sao apagadas. */
const JOURNAL_RETENTION_SECONDS = 7 * 24 * 3600;
const DEFAULT_CONFIG_DIR = '/etc/zeroops-relay';
const MAX_ROWS = 201;
const MAX_CELL = 2000;
const MAX_STATEMENT_SECONDS = 15;
const MAX_LOG_LINES = 200;
const MAX_LOG_DAYS = 14;
const MAX_LOG_BYTES = 200 * 1024 * 1024;
const LOG_TYPES = [
    'api', 'api-public', 'dtq', 'php_errors', 'oreo', 'db2-trace', 'db2_log',
    'moradas', 'loyalty', 'wallet', 'rest_log', 'sdr', 'database-health',
];

final class RelayError extends RuntimeException
{
    /** @var string */
    public $errorCode;

    public function __construct(string $errorCode, string $message)
    {
        parent::__construct($message);
        $this->errorCode = $errorCode;
    }
}

final class RelayConfig
{
    /** @var array<string,string> */
    private $values = [];

    public static function load(string $dir): self
    {
        $config = new self();
        foreach (['relay.env', 'token.env'] as $file) {
            $config->readEnvFile($dir . '/' . $file);
        }
        foreach (['ZEROOPS_URL', 'ZEROOPS_RELAY_TOKEN'] as $required) {
            if ($config->get($required) === '') {
                throw new RuntimeException("Configuração em falta: $required");
            }
        }
        return $config;
    }

    public function get(string $key, string $default = ''): string
    {
        return $this->values[$key] ?? $default;
    }

    private function readEnvFile(string $path): void
    {
        if (!is_readable($path)) {
            throw new RuntimeException("Ficheiro de configuração ilegível: $path");
        }
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            if (preg_match('/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/', $line, $match)) {
                $this->values[$match[1]] = trim($match[2], "\"'");
            }
        }
    }
}

/** Cliente HTTPS para a API do ZeroOps (resolve e CA fixos, como o agente de Saúde). */
final class ZeroOpsClient
{
    /** @var RelayConfig */
    private $config;

    public function __construct(RelayConfig $config)
    {
        $this->config = $config;
    }

    /** @return array<string,mixed> */
    public function post(string $path, array $body, int $timeoutSeconds): array
    {
        $curl = curl_init(rtrim($this->config->get('ZEROOPS_URL'), '/') . $path);
        $options = [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $this->config->get('ZEROOPS_RELAY_TOKEN'),
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => $timeoutSeconds,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ];
        if ($this->config->get('ZEROOPS_RESOLVE') !== '') {
            $options[CURLOPT_RESOLVE] = [$this->config->get('ZEROOPS_RESOLVE')];
        }
        if ($this->config->get('ZEROOPS_CACERT') !== '') {
            $options[CURLOPT_CAINFO] = $this->config->get('ZEROOPS_CACERT');
        }
        curl_setopt_array($curl, $options);
        $response = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
        $error = curl_error($curl);
        curl_close($curl);
        if ($response === false) {
            throw new RuntimeException("Ligação ao ZeroOps falhou: $error");
        }
        if ($status < 200 || $status >= 300) {
            throw new RuntimeException("ZeroOps respondeu HTTP $status em $path");
        }
        $decoded = json_decode((string) $response, true);
        return is_array($decoded) ? $decoded : [];
    }
}

/** Consultas só de leitura na BD do site. */
final class SqlTool
{
    /** @var string */
    private $configDir;

    public function __construct(string $configDir)
    {
        $this->configDir = $configDir;
    }

    /** @var PDO|null */
    private $pdo;

    public function run(array $payload): array
    {
        $query = $this->validate((string) ($payload['query'] ?? ''));
        $pdo = $this->connection();
        $pdo->exec('START TRANSACTION READ ONLY');
        try {
            $statement = preg_match('/^(SELECT|WITH)\b/i', $query)
                ? sprintf(
                    'SET STATEMENT max_statement_time=%d, sql_select_limit=%d FOR %s',
                    MAX_STATEMENT_SECONDS,
                    MAX_ROWS,
                    $query
                )
                : $query;
            $result = $pdo->query($statement);
            $columns = [];
            for ($index = 0; $index < $result->columnCount(); $index++) {
                $meta = $result->getColumnMeta($index);
                $columns[] = (string) ($meta['name'] ?? "col$index");
            }
            $rows = [];
            $truncated = false;
            while (($row = $result->fetch(PDO::FETCH_NUM)) !== false) {
                if (count($rows) >= MAX_ROWS - 1) {
                    $truncated = true;
                    break;
                }
                $rows[] = array_map([$this, 'cell'], $row);
            }
            $result->closeCursor();
            return ['columns' => $columns, 'rows' => $rows, 'truncated' => $truncated];
        } catch (PDOException $error) {
            throw new RelayError('SQL_ERROR', substr($error->getMessage(), 0, 400));
        } finally {
            try {
                $pdo->exec('ROLLBACK');
            } catch (PDOException $error) {
                $this->pdo = null;
            }
        }
    }

    private function validate(string $query): string
    {
        $query = rtrim(trim($query), "; \t\r\n");
        if ($query === '' || strlen($query) > 8000) {
            throw new RelayError('SQL_INVALID', 'Consulta vazia ou demasiado longa.');
        }
        if (strpos($query, ';') !== false) {
            throw new RelayError('SQL_INVALID', 'Só é permitida uma instrução, sem ";".');
        }
        if (!preg_match('/^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i', $query)) {
            throw new RelayError('SQL_READ_ONLY', 'Só são permitidas consultas de leitura.');
        }
        if (preg_match('/\b(INTO\s+(OUT|DUMP)FILE|LOAD_FILE|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE|SLEEP\s*\(|BENCHMARK\s*\(|GET_LOCK\s*\()/i', $query)) {
            throw new RelayError('SQL_READ_ONLY', 'Instrução não permitida no relay.');
        }
        return $query;
    }

    /** @param mixed $value @return mixed */
    private function cell($value)
    {
        if (!is_string($value)) {
            return $value;
        }
        if (!mb_check_encoding($value, 'UTF-8')) {
            return '[binário ' . strlen($value) . ' bytes]';
        }
        return mb_strlen($value) > MAX_CELL ? mb_substr($value, 0, MAX_CELL) . '…' : $value;
    }

    private function connection(): PDO
    {
        if ($this->pdo !== null) {
            try {
                $this->pdo->query('SELECT 1')->closeCursor();
                return $this->pdo;
            } catch (PDOException $error) {
                $this->pdo = null;
            }
        }
        $cnf = parse_ini_file($this->configDir . '/agent-mysql.cnf', true, INI_SCANNER_RAW);
        $client = is_array($cnf) && isset($cnf['client']) ? $cnf['client'] : [];
        if (empty($client['user'])) {
            throw new RelayError('SQL_CONFIG', 'Credenciais MySQL do relay em falta.');
        }
        $dsn = sprintf(
            'mysql:unix_socket=%s;dbname=%s;charset=utf8mb4',
            $client['socket'] ?? '/run/mysqld/mysqld.sock',
            $client['database'] ?? 'pizzahut'
        );
        try {
            $this->pdo = new PDO($dsn, $client['user'], $client['password'] ?? '', [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_TIMEOUT => 5,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::MYSQL_ATTR_MULTI_STATEMENTS => false,
                PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => false,
            ]);
        } catch (PDOException $error) {
            throw new RelayError('SQL_CONNECT', 'Sem ligação à base de dados de Produção.');
        }
        $this->pdo->exec('SET SESSION TRANSACTION READ ONLY');
        return $this->pdo;
    }
}

/** Leitura dos logs da aplicação: lista fechada de tipos, sem shell nem caminhos vindos do pedido. */
final class LogTool
{
    /** @var string */
    private $root;

    public function __construct(string $root)
    {
        $this->root = rtrim($root, '/');
    }

    public function run(array $payload): array
    {
        $type = (string) ($payload['type'] ?? '');
        if (!in_array($type, LOG_TYPES, true)) {
            throw new RelayError('LOG_TYPE', 'Tipo de log desconhecido.');
        }
        $contains = substr((string) ($payload['contains'] ?? ''), 0, 200);
        $limit = max(1, min(MAX_LOG_LINES, (int) ($payload['lines'] ?? 100)));
        $days = max(0, min(MAX_LOG_DAYS, (int) ($payload['days'] ?? 0)));

        $files = $this->files($type, $days);
        if (!$files) {
            throw new RelayError('LOG_MISSING', "Não existem ficheiros de log para \"$type\" no período pedido.");
        }
        $collected = [];
        $read = [];
        $budget = MAX_LOG_BYTES;
        $truncated = false;
        foreach ($files as $file) {
            $read[] = basename($file);
            $lines = $this->tail($file, $contains, $limit, $budget, $truncated);
            $collected = array_merge($lines, $collected);
            if (count($collected) >= $limit || $truncated) {
                break;
            }
        }
        return [
            'lines' => array_slice($collected, -$limit),
            'files' => $read,
            'truncated' => $truncated,
        ];
    }

    /**
     * Ficheiros do mais recente para o mais antigo: atual e, se pedido, os rodados recentes.
     * Sites sem <tipo>.log usam ficheiros diários AAAA_MM_DD.txt (sem pedido de dias, o mais recente).
     */
    private function files(string $type, int $days): array
    {
        $dir = "{$this->root}/$type";
        $files = [];
        if (is_file("$dir/$type.log")) {
            $files[] = "$dir/$type.log";
        } elseif (is_dir($dir)) {
            return $this->dailyFiles($dir, $days);
        }
        if ($days > 0 && is_dir($dir)) {
            $since = (int) date('Ymd', strtotime("-$days days"));
            $rotated = [];
            foreach (scandir($dir) ?: [] as $name) {
                if (preg_match('/^' . preg_quote($type, '/') . '\.log-(\d{8})(\.gz)?$/', $name, $match)
                    && (int) $match[1] >= $since) {
                    $rotated[$match[1] . $name] = "$dir/$name";
                }
            }
            krsort($rotated);
            $files = array_merge($files, array_values($rotated));
        }
        return $files;
    }

    /** Ficheiros diários AAAA_MM_DD.txt, do mais recente para o mais antigo. */
    private function dailyFiles(string $dir, int $days): array
    {
        $since = (int) date('Ymd', strtotime("-$days days"));
        $daily = [];
        foreach (scandir($dir) ?: [] as $name) {
            if (preg_match('/^(\d{4})_(\d{2})_(\d{2})\.txt$/', $name, $match)) {
                $daily[$match[1] . $match[2] . $match[3]] = "$dir/$name";
            }
        }
        krsort($daily);
        if ($days === 0) {
            return array_slice(array_values($daily), 0, 1);
        }
        return array_values(array_filter($daily, function ($day) use ($since) {
            return (int) $day >= $since;
        }, ARRAY_FILTER_USE_KEY));
    }

    /** Últimas linhas que contêm o texto (comparação literal, sem distinguir maiúsculas). */
    private function tail(string $file, string $contains, int $limit, int &$budget, bool &$truncated): array
    {
        $gz = substr($file, -3) === '.gz';
        $handle = $gz ? gzopen($file, 'rb') : fopen($file, 'rb');
        if ($handle === false) {
            return [];
        }
        $lines = [];
        while (true) {
            $line = $gz ? gzgets($handle, 65536) : fgets($handle, 65536);
            if ($line === false) {
                break;
            }
            $budget -= strlen($line);
            if ($budget <= 0) {
                $truncated = true;
                break;
            }
            if ($contains !== '' && stripos($line, $contains) === false) {
                continue;
            }
            $line = rtrim($line, "\r\n");
            if (!mb_check_encoding($line, 'UTF-8')) {
                $line = mb_convert_encoding($line, 'UTF-8', 'ISO-8859-1');
            }
            $lines[] = mb_strlen($line) > MAX_CELL ? mb_substr($line, 0, MAX_CELL) . '…' : $line;
            if (count($lines) > $limit * 2) {
                $lines = array_slice($lines, -$limit);
            }
        }
        $gz ? gzclose($handle) : fclose($handle);
        return array_slice($lines, -$limit);
    }
}

/**
 * Consultas só de leitura no DB2 por ODBC (como o site), com credenciais em <pasta>/agent-db2.ini:
 *   [db2] dsn=..., user=..., password=...  (utilizador DB2 só com SELECT)
 * Só SELECT/WITH/VALUES, sem palavras de escrita, com timeout e limite de linhas; termina em rollback.
 */
final class Db2Tool
{
    /** @var string */
    private $configFile;

    public function __construct(string $configDir)
    {
        $this->configFile = $configDir . '/agent-db2.ini';
    }

    public function available(): bool
    {
        return function_exists('odbc_connect') && is_readable($this->configFile);
    }

    public function run(array $payload): array
    {
        $query = $this->validate((string) ($payload['query'] ?? ''));
        $ini = parse_ini_file($this->configFile, true, INI_SCANNER_RAW);
        $config = is_array($ini) && isset($ini['db2']) ? $ini['db2'] : [];
        if (!$this->available() || empty($config['dsn'])) {
            throw new RelayError('DB2_CONFIG', 'DB2 não configurado neste relay.');
        }
        $connection = @odbc_connect((string) $config['dsn'], (string) ($config['user'] ?? ''), (string) ($config['password'] ?? ''));
        if ($connection === false) {
            throw new RelayError('DB2_CONNECT', 'Sem ligação ao DB2: ' . substr((string) odbc_errormsg(), 0, 300));
        }
        try {
            odbc_autocommit($connection, false);
            $statement = @odbc_prepare($connection, $query);
            if ($statement === false) {
                throw new RelayError('DB2_ERROR', substr((string) odbc_errormsg($connection), 0, 400));
            }
            @odbc_setoption($statement, 2, 0, MAX_STATEMENT_SECONDS);
            if (!@odbc_execute($statement)) {
                throw new RelayError('DB2_ERROR', substr((string) odbc_errormsg($connection), 0, 400));
            }
            $columns = [];
            for ($index = 1; $index <= odbc_num_fields($statement); $index++) {
                $columns[] = (string) odbc_field_name($statement, $index);
            }
            $rows = [];
            $truncated = false;
            while (($row = odbc_fetch_array($statement)) !== false) {
                if (count($rows) >= MAX_ROWS - 1) {
                    $truncated = true;
                    break;
                }
                $rows[] = array_map([$this, 'cell'], array_values($row));
            }
            odbc_free_result($statement);
            return ['columns' => $columns, 'rows' => $rows, 'truncated' => $truncated];
        } finally {
            @odbc_rollback($connection);
            odbc_close($connection);
        }
    }

    private function validate(string $query): string
    {
        $query = rtrim(trim($query), "; \t\r\n");
        if ($query === '' || strlen($query) > 8000 || strpos($query, ';') !== false) {
            throw new RelayError('SQL_INVALID', 'Uma única consulta, sem ";" e até 8000 caracteres.');
        }
        $shape = preg_replace(["/'(?:[^']|'')*'/", '/"(?:[^"]|"")*"/', '/--[^\n]*/', '#/\*.*?\*/#s'], ["''", '""', ' ', ' '], $query);
        if (!preg_match('/^\s*(SELECT|WITH|VALUES)\b/i', (string) $shape)) {
            throw new RelayError('SQL_READ_ONLY', 'No DB2 só são permitidas consultas SELECT.');
        }
        if (preg_match('/\b(INSERT|UPDATE|DELETE|MERGE|CALL|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|RENAME|SET|REFRESH|DECLARE|EXECUTE|PREPARE)\b/i', (string) $shape)) {
            throw new RelayError('SQL_READ_ONLY', 'Instrução de escrita não permitida no DB2.');
        }
        return $query;
    }

    /** @param mixed $value @return mixed */
    private function cell($value)
    {
        if (!is_string($value)) {
            return $value;
        }
        $value = rtrim($value);
        if (!mb_check_encoding($value, 'UTF-8')) {
            $value = mb_convert_encoding($value, 'UTF-8', 'ISO-8859-1');
        }
        return mb_strlen($value) > MAX_CELL ? mb_substr($value, 0, MAX_CELL) . '…' : $value;
    }
}

/**
 * Limites das intervenções, definidos no servidor (relay.env) e não no pedido:
 *   ZEROOPS_ENVIRONMENT      ambiente desta instância (quality ou production)
 *   ALLOWED_UNITS            unidades systemd que se podem reiniciar/ajustar (lista por vírgulas)
 *   ALLOWED_PROPERTIES       propriedades systemd ajustáveis em runtime (por omissão memória/CPU/tarefas)
 *   ALLOW_REBOOT             1 para permitir reiniciar o servidor (por omissão 0)
 * Os ambientes suspensos na Saúde chegam em cada poll e recusam qualquer intervenção.
 */
final class InterventionGuard
{
    /** @var string */
    private $environment;
    /** @var string[] */
    private $units;
    /** @var string[] */
    private $properties;
    /** @var bool */
    private $allowReboot;
    /** @var string[] */
    private $suspended = [];

    public function __construct(RelayConfig $config)
    {
        $this->environment = $config->get('ZEROOPS_ENVIRONMENT');
        $this->units = self::list($config->get('ALLOWED_UNITS'));
        $this->properties = self::list($config->get('ALLOWED_PROPERTIES', 'MemoryHigh,MemoryMax,CPUQuota,TasksMax'));
        $this->allowReboot = $config->get('ALLOW_REBOOT', '0') === '1';
    }

    /** @param mixed[] $environments */
    public function setSuspended(array $environments): void
    {
        $this->suspended = array_values(array_filter(array_map('strval', $environments)));
    }

    public function checkEnvironment(string $requested): void
    {
        foreach ([$requested, $this->environment] as $environment) {
            if ($environment !== '' && in_array($environment, $this->suspended, true)) {
                throw new RelayError('SUSPENDED', "A Saúde está suspensa em \"$environment\": intervenção recusada.");
            }
        }
        if ($this->environment !== '' && $requested !== '' && $requested !== $this->environment) {
            throw new RelayError('ENVIRONMENT', "Este relay serve \"{$this->environment}\", não \"$requested\".");
        }
    }

    public function checkUnit(string $unit): string
    {
        if (!preg_match('/^[A-Za-z0-9@_.:-]{1,120}$/', $unit)) {
            throw new RelayError('UNIT_INVALID', 'Nome de serviço inválido.');
        }
        $name = strpos($unit, '.') === false ? "$unit.service" : $unit;
        if (!in_array($name, $this->units, true) && !in_array($unit, $this->units, true)) {
            throw new RelayError('UNIT_FORBIDDEN', "O serviço \"$unit\" não está autorizado neste servidor.");
        }
        return $name;
    }

    public function checkProperty(string $property, string $value): void
    {
        if (!in_array($property, $this->properties, true)) {
            throw new RelayError('PARAM_FORBIDDEN', "O parâmetro \"$property\" não está autorizado neste servidor.");
        }
        if (!preg_match('/^(infinity|\d{1,12}(\.\d{1,3})?[KMGT%]?)$/', $value)) {
            throw new RelayError('PARAM_INVALID', 'Valor do parâmetro inválido.');
        }
    }

    /** Ferramentas de intervenção configuradas (anunciadas ao ZeroOps). */
    public function enabledKinds(): array
    {
        $kinds = $this->units ? ['restart', 'param'] : [];
        return $this->allowReboot ? array_merge($kinds, ['reboot']) : $kinds;
    }

    public function checkReboot(string $host): void
    {
        if (!$this->allowReboot) {
            throw new RelayError('REBOOT_FORBIDDEN', 'Reiniciar o servidor não está autorizado neste relay.');
        }
        $local = strtolower((string) gethostname());
        $short = strtolower(explode('.', $local)[0]);
        if ($host !== '' && !in_array(strtolower($host), [$local, $short], true)) {
            throw new RelayError('HOST_MISMATCH', "O pedido é para \"$host\", mas este relay corre em \"$local\".");
        }
    }

    /** @return string[] */
    private static function list(string $value): array
    {
        return array_values(array_filter(array_map('trim', explode(',', $value))));
    }
}

/**
 * Intervenções através do systemd (sem shell): reiniciar um serviço autorizado, ajustar uma propriedade
 * em runtime (desaparece no próximo arranque) ou reiniciar o servidor. A autorização ao utilizador do
 * relay é dada por uma regra polkit limitada às mesmas unidades (ver install.sh).
 */
final class InterventionTool
{
    /** @var InterventionGuard */
    private $guard;
    /** @var string */
    private $kind;
    /** @var bool */
    private $rebootPending = false;

    public function __construct(InterventionGuard $guard, string $kind)
    {
        $this->guard = $guard;
        $this->kind = $kind;
    }

    /** Chamado pelo relay depois de entregar o resultado ao ZeroOps (o reboot corta a ligação). */
    public function afterResult(): void
    {
        if ($this->rebootPending) {
            $this->rebootPending = false;
            $this->systemctl(['reboot']);
        }
    }

    public function run(array $payload): array
    {
        $this->guard->checkEnvironment((string) ($payload['environment'] ?? ''));
        if ($this->kind === 'reboot') {
            $this->guard->checkReboot((string) ($payload['host'] ?? ''));
            $this->rebootPending = true;
            return ['previous' => null, 'current' => null, 'message' => 'Reinício do servidor pedido ao systemd.'];
        }
        $unit = $this->guard->checkUnit((string) ($payload['unit'] ?? ''));
        if ($this->kind === 'restart') {
            $before = $this->show($unit, 'ActiveEnterTimestamp');
            $this->systemctl(['restart', $unit]);
            $state = $this->show($unit, 'ActiveState');
            if ($state !== 'active') {
                throw new RelayError('RESTART_FAILED', "O serviço $unit ficou no estado \"$state\" após o reinício.");
            }
            return [
                'previous' => $before !== '' ? "ativo desde $before" : null,
                'current' => 'ativo desde ' . $this->show($unit, 'ActiveEnterTimestamp'),
                'message' => "Serviço $unit reiniciado e ativo.",
            ];
        }
        $property = (string) ($payload['property'] ?? '');
        $value = (string) ($payload['value'] ?? '');
        $this->guard->checkProperty($property, $value);
        $previous = $this->show($unit, $property);
        $this->systemctl(['set-property', '--runtime', $unit, "$property=$value"]);
        return [
            'previous' => $previous !== '' ? $previous : null,
            'current' => $this->show($unit, $property),
            'message' => "$property de $unit alterado em runtime (repõe no próximo arranque ou com o valor anterior).",
        ];
    }

    private function show(string $unit, string $property): string
    {
        return trim($this->systemctl(['show', '-p', $property, '--value', $unit]));
    }

    /** @param string[] $args */
    private function systemctl(array $args): string
    {
        $command = '/usr/bin/systemctl --no-ask-password ' . implode(' ', array_map('escapeshellarg', $args));
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) {
            throw new RelayError('SYSTEMCTL', 'Não foi possível executar o systemctl.');
        }
        $output = (string) stream_get_contents($pipes[1]);
        $error = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        if (proc_close($process) !== 0) {
            throw new RelayError('SYSTEMCTL', substr(trim($error) ?: 'systemctl falhou.', 0, 400));
        }
        return $output;
    }
}

/**
 * Journal local das intervencoes: cada pedido corre no maximo uma vez neste servidor. Um pedido
 * repetido devolve o resultado guardado; um pedido interrompido a meio (relay reiniciado) nunca e
 * repetido e e reportado como resultado desconhecido.
 */
final class InterventionJournal
{
    /** @var string|null */
    private $dir;

    public function __construct(?string $dir)
    {
        $this->dir = ($dir !== null && $dir !== '' && is_dir($dir) && is_writable($dir)) ? rtrim($dir, '/') : null;
        if ($this->dir === null) {
            fwrite(STDERR, date('c') . ' journal de intervencoes indisponivel (StateDirectory).' . PHP_EOL);
        }
    }

    public function available(): bool
    {
        return $this->dir !== null;
    }

    private function file(string $id): string
    {
        return $this->dir . '/' . $id . '.json';
    }

    public function get(string $id): ?array
    {
        if ($this->dir === null || !is_file($this->file($id))) {
            return null;
        }
        $data = json_decode((string) file_get_contents($this->file($id)), true);
        return is_array($data) ? $data : null;
    }

    public function put(string $id, array $entry): void
    {
        if ($this->dir === null) {
            return;
        }
        $tmp = $this->file($id) . '.tmp';
        file_put_contents($tmp, json_encode($entry), LOCK_EX);
        rename($tmp, $this->file($id));
    }

    /** @return array<string,array> resultados ainda nao confirmados pelo ZeroOps */
    public function unsent(): array
    {
        $pending = [];
        if ($this->dir === null) {
            return $pending;
        }
        foreach (glob($this->dir . '/*.json') ?: [] as $file) {
            $id = basename($file, '.json');
            if (filemtime($file) < time() - JOURNAL_RETENTION_SECONDS) {
                @unlink($file);
                continue;
            }
            $entry = $this->get($id);
            if ($entry !== null && ($entry['state'] ?? '') === 'done' && empty($entry['sent'])) {
                $pending[$id] = $entry;
            }
        }
        return $pending;
    }
}

final class Relay
{
    /** @var ZeroOpsClient */
    private $client;
    /** @var array<string,object> */
    private $tools;
    /** @var InterventionGuard|null */
    private $guard;
    /** @var InterventionJournal */
    private $journal;

    public function __construct(ZeroOpsClient $client, array $tools, ?InterventionGuard $guard = null, ?InterventionJournal $journal = null)
    {
        $this->client = $client;
        $this->tools = $tools;
        $this->guard = $guard;
        $this->journal = $journal ?? new InterventionJournal(null);
    }

    public function loop(): void
    {
        $backoff = 1;
        while (true) {
            try {
                $this->resendResults();
                $response = $this->client->post(
                    '/api/relay/poll',
                    ['hostname' => (string) gethostname(), 'version' => RELAY_VERSION, 'tools' => $this->announced()],
                    40
                );
                if ($this->guard !== null) {
                    $suspended = $response['suspendedEnvironments'] ?? [];
                    $this->guard->setSuspended(is_array($suspended) ? $suspended : []);
                }
                foreach ($response['requests'] ?? [] as $request) {
                    if (is_array($request)) {
                        $this->handle($request);
                    }
                }
                $backoff = 1;
            } catch (Throwable $error) {
                fwrite(STDERR, date('c') . ' ' . $error->getMessage() . PHP_EOL);
                sleep($backoff);
                $backoff = min(60, $backoff * 2);
            }
        }
    }

    /** Ferramentas utilizáveis neste servidor (o DB2 só com ODBC e credenciais configurados). */
    private function announced(): array
    {
        $names = [];
        foreach ($this->tools as $name => $tool) {
            if ($tool instanceof Db2Tool && !$tool->available()) {
                continue;
            }
            if ($tool instanceof InterventionTool
                && ($this->guard === null || !in_array($name, $this->guard->enabledKinds(), true))) {
                continue;
            }
            $names[] = (string) $name;
        }
        return $names;
    }

    /** Reenvia resultados de intervenções que o ZeroOps ainda não confirmou (sem voltar a executar). */
    private function resendResults(): void
    {
        foreach ($this->journal->unsent() as $id => $entry) {
            try {
                $this->client->post("/api/relay/requests/$id/result", (array) ($entry['body'] ?? []), 30);
                $entry['sent'] = true;
            } catch (Throwable $error) {
                // 409: o ZeroOps já não espera este resultado; não vale a pena insistir.
                if (strpos($error->getMessage(), 'HTTP 409') === false) {
                    continue;
                }
                $entry['sent'] = true;
            }
            $this->journal->put((string) $id, $entry);
        }
    }

    private function handle(array $request): void
    {
        $id = (string) ($request['id'] ?? '');
        if (!preg_match('/^[0-9a-f-]{36}$/', $id)) {
            return;
        }
        $tool = $this->tools[(string) ($request['tool'] ?? '')] ?? null;
        $payload = is_array($request['payload'] ?? null) ? $request['payload'] : [];
        $intervention = $tool instanceof InterventionTool;
        $ran = false;
        $previous = $intervention ? $this->journal->get($id) : null;
        if ($previous !== null && ($previous['state'] ?? '') === 'done') {
            $body = (array) ($previous['body'] ?? []);
        } elseif ($previous !== null) {
            $body = ['ok' => false, 'code' => 'UNCERTAIN', 'message' => 'O relay foi interrompido durante a intervenção: resultado desconhecido (não repetida).'];
        } else {
            try {
                if ($tool === null) {
                    throw new RelayError('TOOL_UNKNOWN', 'Ferramenta não suportada pelo relay.');
                }
                if ($intervention) {
                    $deadline = isset($payload['deadline']) ? strtotime((string) $payload['deadline']) : false;
                    if ($deadline !== false && time() > $deadline) {
                        throw new RelayError('DEADLINE', 'Pedido recebido fora do prazo: a intervenção não foi executada.');
                    }
                    $this->journal->put($id, ['state' => 'started', 'at' => time(), 'contract' => (string) ($payload['contractVersion'] ?? '')]);
                }
                $ran = true;
                $body = ['ok' => true, 'result' => $tool->run($payload)];
            } catch (RelayError $error) {
                $body = ['ok' => false, 'code' => $error->errorCode, 'message' => $error->getMessage()];
            } catch (Throwable $error) {
                $body = ['ok' => false, 'code' => 'RELAY_ERROR', 'message' => 'Falha interna do relay.'];
                fwrite(STDERR, date('c') . " pedido $id: " . $error->getMessage() . PHP_EOL);
            }
            if ($intervention && $ran) {
                $this->journal->put($id, ['state' => 'done', 'at' => time(), 'body' => $body, 'sent' => false]);
            }
        }
        $sent = false;
        try {
            $this->client->post("/api/relay/requests/$id/result", $body, 30);
            $sent = true;
        } catch (Throwable $error) {
            fwrite(STDERR, date('c') . " resultado $id: " . $error->getMessage() . PHP_EOL);
        }
        if ($intervention && $ran && $sent) {
            $this->journal->put($id, ['state' => 'done', 'at' => time(), 'body' => $body, 'sent' => true]);
        }
        if ($intervention && $ran && !empty($body['ok'])) {
            try {
                $tool->afterResult();
            } catch (Throwable $error) {
                fwrite(STDERR, date('c') . " pedido $id: " . $error->getMessage() . PHP_EOL);
            }
        }
    }
}

$configDir = rtrim((string) ($argv[1] ?? (getenv('ZEROOPS_RELAY_CONFIG_DIR') ?: DEFAULT_CONFIG_DIR)), '/');
if ($configDir === '' || $configDir[0] !== '/' || !is_dir($configDir)) {
    fwrite(STDERR, "Pasta de configuração inválida: $configDir" . PHP_EOL);
    exit(1);
}
$config = RelayConfig::load($configDir);
$guard = new InterventionGuard($config);
$relay = new Relay(new ZeroOpsClient($config), [
    'sql' => new SqlTool($configDir),
    'log' => new LogTool($config->get('LOG_ROOT', '/var/www/vhosts/pizzahut.pt/httpdocs/log')),
    'db2' => new Db2Tool($configDir),
    'restart' => new InterventionTool($guard, 'restart'),
    'reboot' => new InterventionTool($guard, 'reboot'),
    'param' => new InterventionTool($guard, 'param'),
], $guard, new InterventionJournal(getenv('STATE_DIRECTORY') ?: '/var/lib/zeroops-relay'));
$relay->loop();
