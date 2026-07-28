// The single channel through which core reports progress outward.
// The CLI prints to stdout, the web UI forwards over SSE, Electron would use
// IPC. core itself never knows who is listening — that is the whole point.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

/** @param {{phase: string, done?: number, total?: number, file?: string, message?: string}} p */
export function progress(p) {
  bus.emit('progress', p);
}

export function logLine(message) {
  bus.emit('progress', { phase: 'log', message });
}
