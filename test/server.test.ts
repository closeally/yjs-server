import { afterAll, describe, expect, test, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { CreateServerOptions } from '../src/index.js'
import { createServer } from '../src/index.js'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type * as awarenessProtocol from 'y-protocols/awareness'
import { waitForExpect } from './test-utils.js'
import { Awareness } from 'y-protocols/awareness.js'

let PORT_START = 9000

const getPort = () => PORT_START++

const startedServers = new Set<WebSocketServer>()

afterAll(() => {
  startedServers.forEach((wss) => wss.close())
})

function scenario() {
  const port = getPort()
  const wss = new WebSocketServer({ port })
  const serverUrl = `ws://localhost:${port}`

  startedServers.add(wss)

  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }

  const makeServer = (opts?: Partial<CreateServerOptions>) => {
    const server = createServer({ logger, createDoc: () => new Y.Doc(), ...opts })

    wss.on('connection', (ws, req) => {
      void server.handleConnection(ws, req)
    })

    return server
  }

  const makeClient = (
    doc: Y.Doc,
    roomName = 'test',
    opts?: {
      connect?: boolean
      awareness?: awarenessProtocol.Awareness
      params?: Record<string, string>
      WebSocketPolyfill?: typeof WebSocket
      resyncInterval?: number
      maxBackoffTime?: number
      disableBc?: boolean
    },
  ) =>
    new WebsocketProvider(serverUrl, roomName, doc, {
      WebSocketPolyfill: WebSocket,
      disableBc: true,
      ...opts,
    })

  return {
    port,
    wss,
    serverUrl,
    logger,
    makeServer,
    makeClient,
  }
}

describe.concurrent('server', () => {
  test('y-websocket connects', () =>
    new Promise<void>((done) => {
      const { makeServer, makeClient } = scenario()

      makeServer()

      const doc = new Y.Doc()

      const client = makeClient(doc)

      client.on('status', (event: { status: string }) => {
        expect(event.status).toBe('connected')
        done()
      })
    }))

  test('connect after disconnect', async () => {
    const { makeServer, makeClient } = scenario()

    makeServer()

    const doc = new Y.Doc()

    const client = makeClient(doc)

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(true)
    })

    client.disconnect()
    await waitForExpect(() => {
      expect(client.wsconnected).toBe(false)
    })

    client.connect()

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(true)
    })
  })

  test('rejects invalid room name', async () => {
    const { makeServer, makeClient, logger } = scenario()

    makeServer({ docNameFromRequest: (req) => (req.url?.includes('invalid') ? undefined : 'ok') })

    const client = makeClient(new Y.Doc(), 'invalid')

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(false)
      expect(logger.error).toHaveBeenCalled()
    })
  })

  test('syncs doc', async () => {
    const { makeServer, makeClient } = scenario()
    makeServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    await waitForAllSynced([makeClient(doc1), makeClient(doc2)])

    doc1.getMap('root').set('foo', 'bar')

    await waitForExpect(() => {
      expect(doc2.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    })
  })

  test('syncs separate room names', async () => {
    const { makeServer, makeClient } = scenario()

    makeServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const doc3 = new Y.Doc()
    const doc4 = new Y.Doc()

    await waitForAllSynced([
      makeClient(doc1, 'room1'),
      makeClient(doc2, 'room1'),
      makeClient(doc3, 'room2'),
      makeClient(doc4, 'room2'),
    ])

    doc1.getMap('root').set('foo', 'bar')
    doc3.getMap('root').set('something', 'else')

    await waitForExpect(() => {
      expect(doc1.getMap('root').toJSON()).toEqual({ foo: 'bar' })
      expect(doc2.getMap('root').toJSON()).toEqual({ foo: 'bar' })
      expect(doc3.getMap('root').toJSON()).toEqual({ something: 'else' })
      expect(doc4.getMap('root').toJSON()).toEqual({ something: 'else' })
    })
  })

  test('syncs awareness', async () => {
    const { makeServer, makeClient } = scenario()

    makeServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    const awareness1 = new Awareness(doc1)
    const awareness2 = new Awareness(doc2)

    await waitForAllSynced([
      makeClient(doc1, 'room1', { awareness: awareness1 }),
      makeClient(doc2, 'room1', { awareness: awareness2 }),
    ])

    awareness1.setLocalState({ user: 'jonn' })
    awareness2.setLocalState({ user: 'jane' })

    await waitForExpect(() => {
      expect([...awareness1.getStates().values()]).toEqual(
        expect.arrayContaining([{ user: 'jonn' }, { user: 'jane' }]),
      )
      expect([...awareness2.getStates().values()]).toEqual(
        expect.arrayContaining([{ user: 'jonn' }, { user: 'jane' }]),
      )
    })
  })

  test('loads existing doc after a delay', async () => {
    const { makeServer, makeClient } = scenario()

    makeServer({
      docStorage: {
        loadDoc(name, doc) {
          expect(name).toBe('room_123')

          return new Promise((resolve) =>
            setTimeout(() => {
              const existingDoc = new Y.Doc()
              existingDoc.getArray('root').push(['existing', 'doc'])

              Y.applyUpdate(doc, Y.encodeStateAsUpdate(existingDoc))

              expect(doc.getArray('root').toJSON()).toEqual(['existing', 'doc'])

              resolve()
            }, 100),
          )
        },
        storeDoc: vi.fn(),
      },
    })

    const doc = new Y.Doc()
    makeClient(doc, 'room_123')

    await waitForExpect(() => {
      expect(doc.getArray('root').toJSON()).toEqual(['existing', 'doc'])
    })
  })

  test('loads existing doc fast', async () => {
    const { makeServer, makeClient } = scenario()

    makeServer({
      docStorage: {
        loadDoc(name, doc) {
          const existingDoc = new Y.Doc()
          existingDoc.getArray('root').push(['existing', 'doc'])

          Y.applyUpdate(doc, Y.encodeStateAsUpdate(existingDoc))
          return Promise.resolve()
        },
        storeDoc: vi.fn(),
      },
    })

    const doc = new Y.Doc()
    makeClient(doc, 'room_123')

    await waitForExpect(() => {
      expect(doc.getArray('root').toJSON()).toEqual(['existing', 'doc'])
    })
  })

  test('syncs doc after a client joins late', async () => {
    const { makeServer, makeClient } = scenario()

    makeServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    doc1.getMap('root').set('foo', 'bar')

    const client1 = makeClient(doc1)
    const client2 = makeClient(doc2)

    await waitForAllSynced([client1, client2])

    await waitForExpect(() => {
      expect(doc2.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    })

    const doc3 = new Y.Doc()
    makeClient(doc3)

    await waitForExpect(() => {
      expect(doc3.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    })
  })
})

function waitForAllSynced(clients: WebsocketProvider[]) {
  return Promise.all(
    clients.map(
      (client) =>
        new Promise<void>((resolve) =>
          client.once('sync', (isSynced: boolean) => {
            expect(client.wsconnected).toBe(true)

            // wait some ms to make sure the doc modifications in test are sent in a secondary message,
            // not during the initial sync
            if (isSynced) {
              setTimeout(resolve, 50)
            }
          }),
        ),
    ),
  )
}
