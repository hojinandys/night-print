// Share in-flight work, but never preserve a failed or invalid response.
export function createObservationCache(fetcher = globalThis.fetch, timeoutMs = 12000) {
  const requests = new Map();
  return {
    clear(url) { requests.delete(url); },
    get(url, validate = () => true) {
      if (requests.has(url)) return requests.get(url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const pending = (async () => {
        try {
          const response = await fetcher(url, { signal: controller.signal, cache: 'no-cache' });
          if (!response.ok) throw new Error('Observation request failed');
          const data = await response.json();
          if (!validate(data)) throw new Error('Observation identity does not match');
          return data;
        } finally { clearTimeout(timeout); }
      })();
      requests.set(url, pending);
      pending.catch(() => { if (requests.get(url) === pending) requests.delete(url); });
      return pending;
    },
  };
}
