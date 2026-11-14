import type { AgentRun, Comment } from '@zeroops/contracts';

/** Entrada do chat da equipa, por ordem cronológica. */
export type TeamChatItem =
  | { kind: 'note'; key: string; at: string; comment: Comment }
  | { kind: 'system'; key: string; at: string; comment: Comment }
  /** Pedido ao Copilot e a respetiva resposta (nota final ligada ao run, se já existir). */
  | { kind: 'run'; key: string; at: string; run: AgentRun; reply: Comment | null }
  /** Nota do Copilot sem run conhecido (anterior à ligação ou fora dos últimos runs). */
  | { kind: 'agent'; key: string; at: string; comment: Comment };

/**
 * Junta as notas internas e os runs num só fio. A nota final de cada run aparece como a
 * resposta do Copilot a esse pedido, em vez de surgir repetida como mensagem solta.
 */
export function buildTeamThread(comments: Comment[], runs: AgentRun[]): TeamChatItem[] {
  const runIds = new Set(runs.map((run) => run.id));
  const replies = new Map<string, Comment>();
  const items: TeamChatItem[] = [];
  for (const comment of comments) {
    if (comment.visibility !== 'internal') continue;
    if (comment.agentRunId && runIds.has(comment.agentRunId)) {
      replies.set(comment.agentRunId, comment);
      continue;
    }
    const kind =
      comment.authorKind === 'agent'
        ? 'agent'
        : comment.authorKind === 'system'
          ? 'system'
          : 'note';
    items.push({ kind, key: `c:${comment.id}`, at: comment.createdAt, comment });
  }
  for (const run of runs)
    items.push({
      kind: 'run',
      key: `r:${run.id}`,
      at: run.createdAt,
      run,
      reply: replies.get(run.id) ?? null,
    });
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.key.localeCompare(b.key));
}

/** Pedido ativo (em fila ou a correr): recebe as mensagens de seguimento do compositor. */
export function activeRun(runs: AgentRun[] | null | undefined) {
  return runs?.find((run) => run.status === 'queued' || run.status === 'running') ?? null;
}
