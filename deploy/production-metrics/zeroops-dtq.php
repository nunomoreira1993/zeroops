<?php
// Sonda ativa do DTQ de clientes: chama localmente o endpoint real do site
// GET /api/v1/dtq/users/ (api::doDtqUsers: ULTPEDTOS2_161 -> ULTPEDTQR2_31720 no DB2) com a conta
// de testes, pelo mesmo caminho do login (Apache + PHP-FPM do site). So consulta: nao cria encomendas.
// Credenciais da API: lib/rest-api/config.json do site (parceiro interno; 127.0.0.1 e permitido).
// Conta de testes: /etc/zeroops-metrics/dtq-probe.env. Imprime um JSON sem segredos nem dados
// pessoais; nunca falha com excecao.
// Uso: php zeroops-dtq.php /etc/zeroops-metrics/dtq-probe.env

const DEFAULT_SITE_DIR = '/var/www/vhosts/pizzahut.pt/httpdocs';
const DEFAULT_API_HOST = 'backend.pizzahut.pt';
const REQUEST_TIMEOUT_SECONDS = 30;

$probeFile = $argv[1] ?? '/etc/zeroops-metrics/dtq-probe.env';
$result = ['configured' => false, 'up' => false];

set_error_handler(static function (): bool {
    return true;
});

$probe = readProbeConfig($probeFile);
$api = $probe === null ? null : readApiConfig($probe['site_dir']);
if ($probe === null || $api === null || !function_exists('curl_init')) {
    echo json_encode($result);
    exit(0);
}
$result['configured'] = true;

$query = http_build_query([
    'phone' => $probe['phone'],
    'street' => $probe['street'],
    'door' => $probe['door'],
    'postal_code' => $probe['postal_code'],
    'postal_code_location' => $probe['postal_location'],
    'local' => $probe['locality'],
]);
$headers = ['accept: application/json'];
if ($api['disposable_sessions']) {
    // Igual ao getAPIData do site: a sessao interna da API e descartada no fim do pedido.
    $headers[] = 'X-Internal-Disposable-Session: '
        . hash_hmac('sha256', 'disposable-internal-api-session', $api['password']);
}

$curl = curl_init('https://' . $probe['host'] . $api['path'] . 'dtq/users/?' . $query);
curl_setopt_array($curl, [
    CURLOPT_RESOLVE => [$probe['host'] . ':443:127.0.0.1'],
    CURLOPT_USERPWD => $api['user'] . ':' . $api['password'],
    CURLOPT_HTTPAUTH => CURLAUTH_BASIC,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => REQUEST_TIMEOUT_SECONDS,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => 0,
]);
unset($api);
$started = microtime(true);
$body = curl_exec($curl);
$result['seconds'] = round(microtime(true) - $started, 4);
$result['http_status'] = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);

$decoded = is_string($body) ? json_decode($body, true) : null;
$result['up'] = $result['http_status'] === 200 && is_array($decoded)
    && ($decoded['_status'] ?? '') === 'success' && !empty($decoded['data']);

echo json_encode($result);

/**
 * Le a conta de testes (KEY=valor); devolve null se faltar algum campo obrigatorio.
 *
 * @return array<string,string>|null
 */
function readProbeConfig(string $path): ?array
{
    $lines = is_readable($path) ? file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : false;
    if ($lines === false) {
        return null;
    }
    $values = [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $values[trim($key)] = trim(trim($value), "\"'");
    }
    $required = [
        'phone' => 'DTQ_PROBE_PHONE',
        'street' => 'DTQ_PROBE_STREET',
        'door' => 'DTQ_PROBE_DOOR',
        'postal_code' => 'DTQ_PROBE_POSTAL_CODE',
        'postal_location' => 'DTQ_PROBE_POSTAL_LOCATION',
        'locality' => 'DTQ_PROBE_LOCALITY',
    ];
    $probe = [];
    foreach ($required as $field => $key) {
        if (!isset($values[$key]) || $values[$key] === '') {
            return null;
        }
        $probe[$field] = $values[$key];
    }
    if (preg_match('/^\d{9}$/', $probe['phone']) !== 1) {
        return null;
    }
    $probe['site_dir'] = rtrim($values['DTQ_PROBE_SITE_DIR'] ?? DEFAULT_SITE_DIR, '/');
    $probe['host'] = $values['DTQ_PROBE_HOST'] ?? DEFAULT_API_HOST;
    return $probe;
}

/**
 * Credenciais da API interna do site (as mesmas que o frontend usa no getAPIData).
 *
 * @return array{user:string,password:string,path:string,disposable_sessions:bool}|null
 */
function readApiConfig(string $siteDir): ?array
{
    $config = json_decode((string) @file_get_contents($siteDir . '/lib/rest-api/config.json'), true);
    $user = $config['auth']['user'] ?? '';
    $password = $config['auth']['pwd'] ?? '';
    if (!is_string($user) || !is_string($password) || $user === '' || $password === '') {
        return null;
    }
    return [
        'user' => $user,
        'password' => $password,
        'path' => (string) ($config['url'] ?? '/api/v1/'),
        'disposable_sessions' => ($config['disposable_sessions'] ?? false) === true,
    ];
}
