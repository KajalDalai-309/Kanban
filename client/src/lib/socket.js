const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const PING_EVERY_MS = 20000;
const DEAD_AFTER_MS = 45000;

/**
 * One WebSocket for one tenant. Reconnects with backoff, and sends a ping now and
 * then so a half-open connection (laptop sleep, wifi change) is noticed and replaced.
 * status: 'connecting' | 'online' | 'reconnecting' | 'closed'
 */
export function connectTenantSocket({ tenantId, token, onStatus, onPresence, onEvent, onKicked }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let ws = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let lastSeen = 0;
  let kicked = false;

  const stopPing = () => clearInterval(pingTimer);
  const startPing = () => {
    stopPing();
    pingTimer = setInterval(() => {
      if (Date.now() - lastSeen > DEAD_AFTER_MS) return ws.close();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_EVERY_MS);
  };

  const handleKicked = () => {
    if (kicked) return;
    kicked = true;
    onKicked?.();
  };

  function open() {
    clearTimeout(retryTimer);
    onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(url);
    ws = socket;
    lastSeen = Date.now();

    socket.onopen = () => socket.send(JSON.stringify({ type: 'join', token, tenantId }));

    socket.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      lastSeen = Date.now();
      if (msg.type === 'joined') {
        attempt = 0;
        onPresence(msg.presence);
        onStatus('online');
        startPing();
      } else if (msg.type === 'presence' && msg.tenantId === tenantId) {
        onPresence(msg.users);
      } else if (msg.type === 'event' && msg.tenantId === tenantId) {
        onEvent(msg);
      } else if (msg.type === 'kicked') {
        handleKicked();
      }
    };

    socket.onclose = (e) => {
      stopPing();
      if (stopped || socket !== ws) return;
      if (e.code === 4401 || e.code === 4403) {
        onStatus('closed');
        if (e.code === 4403) handleKicked();
        return;
      }
      onStatus('reconnecting');
      retryTimer = setTimeout(open, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
    };

    socket.onerror = () => socket.close();
  }

  open();

  return {
    // Called when the browser says it is back online: do not wait for the backoff timer.
    reconnectNow() {
      if (stopped || kicked || ws?.readyState === WebSocket.OPEN) return;
      attempt = 0;
      ws?.close();
      open();
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      stopPing();
      ws?.close();
    },
  };
}
