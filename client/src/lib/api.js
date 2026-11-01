const TOKEN_KEY = 'kanban.token';
let token = localStorage.getItem(TOKEN_KEY);

export const getToken = () => token;
export function setToken(value) {
  token = value;
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
}

// The server answered with an error status.
export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = error?.code;
    this.details = error; // e.g. { conflicts, current } on a 409
  }
}

// The request never got an answer (offline, server down). These can be retried later.
export class NetworkError extends Error {
  constructor() {
    super('Cannot reach the server');
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new NetworkError();
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // a proxy error page, for example; treat as a server failure below
  }
  if (!res.ok) {
    if (res.status === 401 && token) window.dispatchEvent(new Event('kanban:unauthorized'));
    // 502/503/504 come from the dev proxy or a load balancer while the server is down
    if (!data && res.status >= 502) throw new NetworkError();
    throw new ApiError(res.status, data?.error);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};
