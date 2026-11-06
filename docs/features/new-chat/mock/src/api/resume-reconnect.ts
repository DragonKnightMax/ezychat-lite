import type { Socket } from 'socket.io-client';

type ResumeSocket = Pick<Socket, 'active' | 'connected'> & {
  io: { engine?: { readyState: string } };
  connect(): unknown;
  disconnect(): unknown;
  on(event: 'connect' | 'disconnect', listener: () => void): unknown;
  off(event: 'connect' | 'disconnect', listener: () => void): unknown;
};

/** Reconnect a live session when its page resumes, without background wake-ups. */
export function registerResumeReconnect(socket: ResumeSocket): () => void {
  let resumePending = false;
  const reconnect = () => {
    const state = socket.io.engine?.readyState;
    if (
      document.visibilityState !== 'visible' ||
      !navigator.onLine ||
      !socket.active ||
      socket.connected ||
      state === 'opening' ||
      state === 'open'
    )
      return;

    resumePending = false;
    // connect() alone waits for a pending Socket.IO backoff. The public disconnect/connect
    // pair cancels that wait; the new opening transport also coalesces simultaneous events.
    socket.disconnect();
    socket.connect();
  };
  const onResume = () => {
    resumePending = document.visibilityState === 'visible' && navigator.onLine && socket.active;
    if (resumePending) reconnect();
  };
  const onConnect = () => {
    resumePending = false;
  };
  const onDisconnect = () => {
    // A suspended page can receive its overdue close event after visibilitychange.
    // Let Socket.IO finish scheduling its retry before replacing that pending attempt.
    if (resumePending)
      queueMicrotask(() => {
        if (resumePending) reconnect();
      });
  };
  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  document.addEventListener('visibilitychange', onResume);
  document.addEventListener('resume', onResume);
  window.addEventListener('pageshow', onResume);
  window.addEventListener('online', onResume);
  return () => {
    resumePending = false;
    socket.off('connect', onConnect);
    socket.off('disconnect', onDisconnect);
    document.removeEventListener('visibilitychange', onResume);
    document.removeEventListener('resume', onResume);
    window.removeEventListener('pageshow', onResume);
    window.removeEventListener('online', onResume);
  };
}
