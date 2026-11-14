<?php
// Estado do DB2/IBM i para o coletor do ZeroOps: so leituras, com as credenciais do DSN ODBC
// (as mesmas que a aplicacao usa). Imprime um JSON sem segredos; nunca falha com excecao.
// Uso: php zeroops-db2.php PROD

$dsn = $argv[1] ?? 'PROD';
$result = ['up' => false];

$ini = @parse_ini_file('/etc/odbc.ini', true, INI_SCANNER_RAW);
$entry = is_array($ini) ? ($ini[$dsn] ?? null) : null;
if (!is_array($entry) || empty($entry['UserID']) || !isset($entry['Password']) || !function_exists('odbc_connect')) {
    echo json_encode($result);
    exit(0);
}

set_error_handler(static function (): bool {
    return true;
});

$started = microtime(true);
$connection = odbc_connect($dsn, $entry['UserID'], $entry['Password']);
unset($entry, $ini);
if ($connection === false) {
    echo json_encode($result);
    exit(0);
}
$result['connect_seconds'] = round(microtime(true) - $started, 4);

$started = microtime(true);
$ping = odbc_exec($connection, 'SELECT 1 FROM SYSIBM.SYSDUMMY1');
if ($ping === false || !odbc_fetch_row($ping)) {
    odbc_close($connection);
    echo json_encode($result);
    exit(0);
}
$result['query_seconds'] = round(microtime(true) - $started, 4);
$result['up'] = true;

// Disponibilidade confirmada: publica ja uma linha, para que um atraso nas estatisticas
// (timeout do coletor) nao seja interpretado como DB2 em baixo.
echo json_encode($result), "\n";
flush();

// A vista _BASIC devolve as mesmas colunas em ~1 s; a SYSTEM_STATUS_INFO completa demora
// 10-25 s (calcula detalhe de ~31 mil jobs) e provocava timeouts e falsos alertas.
// ELAPSED_CPU_USED e medido desde a leitura anterior na mesma ligacao: le, espera e volta a ler.
$status = null;
for ($attempt = 0; $attempt < 2; $attempt++) {
    $statement = odbc_exec($connection, 'SELECT ELAPSED_CPU_USED, CURRENT_CPU_CAPACITY, CONFIGURED_CPUS, '
        . 'SYSTEM_ASP_USED, ACTIVE_JOBS_IN_SYSTEM, TOTAL_JOBS_IN_SYSTEM, MAXIMUM_JOBS_IN_SYSTEM, '
        . 'ACTIVE_THREADS_IN_SYSTEM, CURRENT_TEMPORARY_STORAGE FROM QSYS2.SYSTEM_STATUS_INFO_BASIC');
    $status = $statement === false ? null : odbc_fetch_array($statement);
    if ($attempt === 0) {
        sleep(5);
    }
}
odbc_close($connection);

if (is_array($status)) {
    $map = [
        'cpu_used_percent' => 'ELAPSED_CPU_USED',
        'cpu_capacity' => 'CURRENT_CPU_CAPACITY',
        'configured_cpus' => 'CONFIGURED_CPUS',
        'asp_used_percent' => 'SYSTEM_ASP_USED',
        'active_jobs' => 'ACTIVE_JOBS_IN_SYSTEM',
        'total_jobs' => 'TOTAL_JOBS_IN_SYSTEM',
        'maximum_jobs' => 'MAXIMUM_JOBS_IN_SYSTEM',
        'active_threads' => 'ACTIVE_THREADS_IN_SYSTEM',
        'temporary_storage_mb' => 'CURRENT_TEMPORARY_STORAGE',
    ];
    foreach ($map as $key => $column) {
        if (isset($status[$column]) && is_numeric($status[$column])) {
            $result[$key] = (float) $status[$column];
        }
    }
}

echo json_encode($result);
