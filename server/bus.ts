import { EventEmitter } from 'node:events'

/** Every domain event flows through here: SSE, outgoing webhooks and automations all subscribe. */
export const bus = new EventEmitter()
bus.setMaxListeners(0)

export type AppEvent = { event: string; data: any; meta?: { sentBy?: string } }
export function emit(event: string, data: any, meta?: AppEvent['meta']) {
  bus.emit('event', { event, data, meta } satisfies AppEvent)
}
