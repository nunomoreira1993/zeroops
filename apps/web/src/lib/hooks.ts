import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from './api';
import { useProjectSession } from './project-admin';

export function useResource<T>(path: string | null, refreshMs = 0) {
  const { request } = useProjectSession();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    if (!path) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    let inFlight = false;
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      void request<T>(path, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) {
            setData(result);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(cause));
        })
        .finally(() => {
          inFlight = false;
          if (!controller.signal.aborted) setLoading(false);
        });
    };
    load();
    const timer =
      refreshMs > 0
        ? window.setInterval(() => {
            if (document.visibilityState === 'visible') load();
          }, refreshMs)
        : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [path, request, revision, refreshMs]);
  return { data, loading, error, reload };
}

export function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function useRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
