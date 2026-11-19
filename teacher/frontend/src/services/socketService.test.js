import { describe, it, expect, vi, beforeEach } from 'vitest';

// A stand-in for socket.io-client that lets the test fire the socket's own events.
const handlers = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: (event, fn) => {
      handlers[event] = fn;
    },
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

const { socketService } = await import('./socketService');
const { io } = await import('socket.io-client');

beforeEach(() => {
  socketService.disconnect();
  for (const k of Object.keys(handlers)) delete handlers[k];
});

describe('socketService connection status', () => {
  it('tells a subscriber that arrives after the connection that it is connected', async () => {
    socketService.connect();
    handlers.connect(); // connected before anyone listened - the session check's case
    const seen = [];
    socketService.on('connection:status', ({ status }) => seen.push(status));
    await Promise.resolve();
    expect(seen).toEqual(['connected']);
  });

  it('still delivers live changes after the replay', async () => {
    socketService.connect();
    handlers.connect();
    const seen = [];
    socketService.on('connection:status', ({ status }) => seen.push(status));
    await Promise.resolve();
    handlers.disconnect('transport close');
    expect(seen).toEqual(['connected', 'disconnected']);
  });

  it('replays nothing before the first status, and nothing to an unsubscribed listener', async () => {
    const early = vi.fn();
    socketService.on('connection:status', early);
    await Promise.resolve();
    expect(early).not.toHaveBeenCalled();

    socketService.connect();
    handlers.connect();
    const late = vi.fn();
    const off = socketService.on('connection:status', late);
    off();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });

  it('connects to the API origin when no socket URL is configured', () => {
    socketService.connect();
    const url = io.mock.calls.at(-1)[0];
    expect(url).not.toMatch(/\/api/);
    expect(url).toMatch(/^https?:\/\/[^/]+$/);
  });
});
