// Thin, defensive clients for the two local services. Every call has a
// timeout, parses JSON once, and surfaces the service's own error message.
export class ApiError extends Error {
  constructor(message, { status = 0, detail = null, body = null } = {}) {
    super(message); this.name = 'ApiError'; this.status = status; this.detail = detail; this.body = body;
  }
}

export async function fetchJson(url, { method = 'GET', body, timeoutMs = 20000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener?.('abort', relay, { once: true });
  try {
    const response = await fetch(url, {
      method, cache: 'no-store', signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let value = null;
    try { value = await response.json(); } catch { /* handled below */ }
    if (!response.ok || value === null) {
      const message = typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message
        || (value === null ? `The local service is unavailable (${response.status})` : `Request failed (${response.status})`);
      throw new ApiError(message, { status: response.status, detail: value?.detail ?? null, body: value });
    }
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') throw new ApiError(signal?.aborted ? 'Cancelled' : 'The local service did not answer in time', { status: 0 });
    throw new ApiError('The local service is unavailable', { status: 0 });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', relay);
  }
}

const post = (url, body, options = {}) => fetchJson(url, { ...options, method: 'POST', body });

export const draftApi = {
  catalog: () => fetchJson('/api/catalog', { timeoutMs: 120000 }),
  generatePreset: ({ preset, lengthScale = 1, legScale = 1 }) => post('/api/generate', { preset, lengthScale, legScale }, { timeoutMs: 120000 }),
  flowerStatus: () => fetchJson('/api/flower-status', { timeoutMs: 6000 }),
};

export const aiApi = {
  health: () => fetchJson('/ai/health', { timeoutMs: 6000 }),
  chat: (messages, state, signal) => post('/ai/chat', { messages, state }, { timeoutMs: 120000, signal }),
  critique: (payload, signal) => post('/ai/critique', payload, { timeoutMs: 120000, signal }),
};
