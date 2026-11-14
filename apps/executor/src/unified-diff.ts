/** Linhas acima deste limite (por ficheiro) usam um diff de substituição integral. */
const LCS_LIMIT = 3000;
const CONTEXT = 3;

type Op = { kind: ' ' | '-' | '+'; line: string };

function lines(text: string) {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function diffOps(before: string[], after: string[]): Op[] {
  if (before.length > LCS_LIMIT || after.length > LCS_LIMIT)
    return [
      ...before.map((line) => ({ kind: '-' as const, line })),
      ...after.map((line) => ({ kind: '+' as const, line })),
    ];
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i -= 1)
    for (let j = after.length - 1; j >= 0; j -= 1)
      table[i * cols + j] =
        before[i] === after[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: ' ', line: before[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      ops.push({ kind: '-', line: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: '+', line: after[j]! });
      j += 1;
    }
  }
  while (i < before.length) ops.push({ kind: '-', line: before[i++]! });
  while (j < after.length) ops.push({ kind: '+', line: after[j++]! });
  return ops;
}

/**
 * Diff unificado (formato `git apply`/`patch -p1`) de um ficheiro. `before` null = ficheiro novo.
 * Devolve string vazia quando não há diferenças.
 */
export function unifiedDiff(path: string, before: string | null, after: string) {
  const ops = diffOps(lines(before ?? ''), lines(after));
  if (!ops.some((op) => op.kind !== ' ')) return '';
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(before === null ? ['new file mode 100644'] : []),
    before === null ? '--- /dev/null' : `--- a/${path}`,
    `+++ b/${path}`,
  ];
  const hunks: string[] = [];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index]!.kind === ' ') index += 1;
    if (index >= ops.length) break;
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    // Junta alterações separadas por até 2*CONTEXT linhas iguais no mesmo bloco.
    for (;;) {
      while (end < ops.length && ops[end]!.kind !== ' ') end += 1;
      let gap = end;
      while (gap < ops.length && ops[gap]!.kind === ' ' && gap - end < CONTEXT * 2) gap += 1;
      if (gap < ops.length && ops[gap]!.kind !== ' ') end = gap;
      else break;
    }
    const stop = Math.min(ops.length, end + CONTEXT);
    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < start; k += 1) {
      if (ops[k]!.kind !== '+') oldStart += 1;
      if (ops[k]!.kind !== '-') newStart += 1;
    }
    const slice = ops.slice(start, stop);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    hunks.push(
      `@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`,
      ...slice.map((op) => `${op.kind}${op.line}`),
    );
    index = stop;
  }
  return `${[...header, ...hunks].join('\n')}\n`;
}
