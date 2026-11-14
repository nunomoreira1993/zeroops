/**
 * Cliente usado pelos comandos `zo-sql`, `zo-log`, `zo-loki` e `zo-prom` dentro do executor. Só
 * conhece o URL dos conectores e o token do run atual; as credenciais das fontes ficam no serviço
 * de conectores. `--env production` encaminha o pedido para o relay instalado em Produção.
 */
const [tool, ...rawArgs] = process.argv.slice(2);
const envFlag = rawArgs[0] === '--env' ? rawArgs[1] : undefined;
const args = envFlag !== undefined ? rawArgs.slice(2) : rawArgs;
const environment = envFlag ?? 'quality';
const url = process.env.ZEROOPS_CONNECTOR_URL;
const token = process.env.ZEROOPS_RUN_TOKEN;

function usage(): never {
  console.error(
    [
      'Utilizacao (--env production|quality, por omissao quality):',
      '  zo-sql [--env production] "SELECT ... FROM ... WHERE ... LIMIT 50"',
      '  zo-db2 --env production "SELECT ... FROM ... FETCH FIRST 50 ROWS ONLY"',
      '  zo-log [--env production] <tipo> ["texto"] [linhas] [dias]',
      '  zo-loki \'{job="php"} |= "texto"\' [janela: 30m|6h|2d] [limite]',
      "  zo-prom 'up' [janela: 30m|6h|2d]",
    ].join('\n'),
  );
  process.exit(2);
}

function cell(value: unknown) {
  if (value === null || value === undefined) return 'NULL';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

async function main() {
  if (!url || !token) throw new Error('Conectores indisponiveis neste ambiente.');
  if (environment !== 'quality' && environment !== 'production') usage();
  let payload: Record<string, unknown>;
  if ((tool === 'sql' || tool === 'db2') && args.length) payload = { query: args.join(' ') };
  else if (tool === 'log' && args[0])
    payload = {
      type: args[0],
      ...(args[1] ? { contains: args[1] } : {}),
      ...(args[2] ? { lines: Number(args[2]) } : {}),
      ...(args[3] ? { days: Number(args[3]) } : {}),
    };
  else if (tool === 'loki' && args[0])
    payload = {
      query: args[0],
      ...(args[1] ? { since: args[1] } : {}),
      ...(args[2] ? { limit: Number(args[2]) } : {}),
    };
  else if (tool === 'prom' && args[0])
    payload = { query: args[0], ...(args[1] ? { window: args[1] } : {}) };
  else usage();
  const response = await fetch(`${url}/v1/${environment}/${tool}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`Erro (${response.status}): ${String(body.error ?? 'pedido recusado')}`);
    process.exit(1);
  }
  console.log(`# ambiente: ${environment === 'production' ? 'PRODUCAO (dados reais)' : 'QA'}`);
  if (tool === 'sql' || tool === 'db2') {
    const { columns, rows, truncated } = body as {
      columns: string[];
      rows: unknown[][];
      truncated: boolean;
    };
    console.log(columns.join('\t'));
    for (const row of rows) console.log(row.map(cell).join('\t'));
    console.log(
      `(${rows.length} linha(s)${truncated ? ', resultado truncado: refine a consulta' : ''})`,
    );
  } else if (tool === 'prom') {
    const { series } = body as {
      series: { labels: Record<string, string>; points: [number, number][] }[];
    };
    for (const item of series) {
      const labels = Object.entries(item.labels)
        .map(([key, value]) => `${key}="${value}"`)
        .join(',');
      const points = item.points.map(
        ([time, value]) => `${new Date(time * 1000).toISOString().slice(0, 19)}Z=${value}`,
      );
      console.log(
        `{${labels}} ${points.length === 1 ? String(item.points[0]![1]) : points.join(' ')}`,
      );
    }
    console.log(`(${series.length} série(s))`);
  } else if (tool === 'log') {
    const { lines, files, truncated } = body as {
      lines: string[];
      files: string[];
      truncated: boolean;
    };
    for (const line of lines) console.log(line);
    console.log(
      `(${lines.length} linha(s) de ${files.length} ficheiro(s)${truncated ? ', leitura limitada: reduza os dias ou refine o texto' : ''})`,
    );
  } else {
    const { lines } = body as {
      lines: { time: string; labels: Record<string, string>; line: string }[];
    };
    for (const line of lines) {
      const labels = Object.entries(line.labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
      console.log(`${line.time} [${labels}] ${line.line}`);
    }
    console.log(`(${lines.length} linha(s))`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no conector.');
  process.exit(1);
});
