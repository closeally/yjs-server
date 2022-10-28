import defaultWaitForExpect from 'wait-for-expect'
import type { WebsocketProvider } from 'y-websocket'
import { expect } from 'vitest'

export const waitForExpect =
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  defaultWaitForExpect as unknown as typeof import('wait-for-expect').default

export function waitForSyncEvent(clients: WebsocketProvider[]) {
  return Promise.all(
    clients.map(
      (client) =>
        new Promise<void>((resolve) =>
          client.once('sync', (isSynced: boolean) => {
            expect(client.wsconnected).toBe(true)

            if (isSynced) {
              setTimeout(resolve, 50)
            }
          }),
        ),
    ),
  )
}

export function waitForDisconnectEvent(clients: WebsocketProvider[], plusMS = 0) {
  return Promise.all(
    clients.map(
      (client) =>
        new Promise<void>((resolve) => {
          const onStatus = ({ status }: { status: string }) => {
            if (status === 'disconnected') {
              expect(client.wsconnected).toBe(false)
              client.off('status', onStatus)

              if (plusMS) setTimeout(resolve, plusMS)
              else resolve()
            }
          }

          client.on('status', onStatus)
        }),
    ),
  )
}
