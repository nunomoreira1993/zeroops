import { useEffect, useRef, useState } from 'react';
import type { AgentRunEvent, AgentRunStatus } from '@zeroops/contracts';
import { errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';

const PAGE_SIZE = 500;
const POLL_MS = 2000;

interface EventsPage {
  events: AgentRunEvent[];
  status: AgentRunStatus;
}

/**
 * Eventos da conversa de um run. Enquanto o run está ativo usa SSE (`/events/stream`) e, se o
 * proxy ou o browser cortarem a ligação, continua por polling a partir do último id recebido.
 */
export function useAgentRunEvents(ticketId: string, runId: string, active: boolean) {
  const { request } = useSession();
  const [events, setEvents] = useState<AgentRunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const lastId = useRef(0);
  const base = `/tickets/${ticketId}/agent-runs/${encodeURIComponent(runId)}/events`;

  useEffect(() => {
    setEvents([]);
    lastId.current = 0;
  }, [base]);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const append = (incoming: AgentRunEvent[]) => {
      const fresh = incoming.filter((event) => event.id > lastId.current);
      const newest = fresh.at(-1);
      if (!newest) return;
      lastId.current = newest.id;
      setEvents((current) => [...current, ...fresh]);
    };

    const fetchAll = async (): Promise<AgentRunStatus> => {
      for (;;) {
        const page = await request<EventsPage>(`${base}?after=${lastId.current}`, {
          signal: controller.signal,
        });
        append(page.events);
        if (page.events.length < PAGE_SIZE) return page.status;
      }
    };

    const poll = () => {
      timer = setTimeout(() => {
        void fetchAll()
          .then((status) => {
            setError(null);
            if (!disposed && ['queued', 'running'].includes(status)) poll();
          })
          .catch((reason: unknown) => {
            if (disposed) return;
            setError(errorMessage(reason));
            poll();
          });
      }, POLL_MS);
    };

    let failures = 0;
    const stream = () => {
      if (typeof EventSource === 'undefined') return poll();
      source = new EventSource(`/api${base}/stream?after=${lastId.current}`, {
        withCredentials: true,
      });
      source.addEventListener('open', () => {
        failures = 0;
        setLive(true);
      });
      source.addEventListener('agent', (message) => {
        append([JSON.parse((message as MessageEvent<string>).data) as AgentRunEvent]);
      });
      source.addEventListener('end', () => {
        source?.close();
        setLive(false);
      });
      source.addEventListener('error', () => {
        source?.close();
        setLive(false);
        if (disposed) return;
        failures += 1;
        if (failures >= 3) poll();
        else timer = setTimeout(stream, 1000 * failures);
      });
    };

    void fetchAll()
      .then(() => {
        setError(null);
        if (!disposed && active) stream();
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setError(errorMessage(reason));
        if (active) poll();
      });

    return () => {
      disposed = true;
      controller.abort();
      source?.close();
      if (timer) clearTimeout(timer);
      setLive(false);
    };
  }, [base, active, request]);

  return { events, error, live };
}
