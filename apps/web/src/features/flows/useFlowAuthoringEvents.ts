import { useEffect, useRef, useState } from 'react';
import type { FlowAuthoringEventView } from '@zeroops/contracts';
import { errorMessage } from '../../lib/api';
import { projectAdminPath, useProjectAdmin, useProjectSession } from '../../lib/project-admin';

const PAGE_SIZE = 200;
const MAX_PAGES = 20;
const KEEP = 300;
const POLL_MS = 2000;

/**
 * Eventos persistentes da construção de um fluxo (P06). Faz replay a partir do cursor, segue por
 * SSE e, se o proxy cortar a ligação, continua por polling. Cada evento é entregue uma única vez
 * (deduplicado pelo id), também depois de reconectar; `onEvent` só recebe eventos novos face ao
 * replay inicial, para o editor recarregar o estado confirmado no servidor.
 */
export function useFlowAuthoringEvents(
  basePath: string,
  onEvent: (event: FlowAuthoringEventView) => void,
) {
  const { request } = useProjectSession();
  const projectId = useProjectAdmin()?.project.id ?? null;
  const [events, setEvents] = useState<FlowAuthoringEventView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const lastId = useRef(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const path = `${basePath}/authoring/events`;

  useEffect(() => {
    let disposed = false;
    let replayed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    lastId.current = 0;
    setEvents([]);

    const append = (incoming: FlowAuthoringEventView[]) => {
      const fresh = incoming.filter((event) => event.id > lastId.current);
      const newest = fresh.at(-1);
      if (!newest || disposed) return;
      lastId.current = newest.id;
      setEvents((current) => [...current, ...fresh].slice(-KEEP));
      if (replayed) for (const event of fresh) handler.current(event);
    };

    const fetchMissing = async () => {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const batch = await request<FlowAuthoringEventView[]>(`${path}?after=${lastId.current}`, {
          signal: controller.signal,
        });
        append(batch);
        if (batch.length < PAGE_SIZE) return;
      }
    };

    const poll = () => {
      timer = setTimeout(() => {
        void fetchMissing()
          .then(() => setError(null))
          .catch((reason: unknown) => {
            if (!disposed) setError(errorMessage(reason));
          })
          .finally(() => {
            if (!disposed) poll();
          });
      }, POLL_MS);
    };

    let failures = 0;
    const stream = () => {
      if (typeof EventSource === 'undefined' || !projectId) return poll();
      const url = projectAdminPath(projectId, `${path}/stream`);
      source = new EventSource(`/api${url}?after=${lastId.current}`, { withCredentials: true });
      source.addEventListener('open', () => {
        failures = 0;
        setLive(true);
        setError(null);
      });
      source.addEventListener('authoring', (message) => {
        append([JSON.parse((message as MessageEvent<string>).data) as FlowAuthoringEventView]);
      });
      source.addEventListener('error', () => {
        source?.close();
        setLive(false);
        if (disposed) return;
        failures += 1;
        // Ao reconectar recupera primeiro o que faltou (replay pelo cursor) e só depois segue.
        if (failures >= 3) poll();
        else
          timer = setTimeout(() => {
            void fetchMissing()
              .catch(() => undefined)
              .finally(() => {
                if (!disposed) stream();
              });
          }, 1000 * failures);
      });
    };

    void fetchMissing()
      .then(() => {
        replayed = true;
        setError(null);
        if (!disposed) stream();
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        replayed = true;
        setError(errorMessage(reason));
        poll();
      });

    return () => {
      disposed = true;
      controller.abort();
      source?.close();
      if (timer) clearTimeout(timer);
      setLive(false);
    };
  }, [path, projectId, request]);

  return { events, error, live };
}
