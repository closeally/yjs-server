import { describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { waitForAllDisconnected, waitForAllSynced, waitForExpect } from './test-utils.js'
import { Awareness } from 'y-protocols/awareness.js'
import { makeLogger, wsScenario } from './fixtures.js'
import { CloseReason } from '../src/types.js'
import { createServer } from '../src/index.js'

// afterAll(() => {
//   startedServers.forEach((wss) => wss.close())
// })

describe.concurrent('server', () => {
  test('y-websocket connects', () =>
    new Promise<void>((done) => {
      const { connectYjsServer, makeClient } = wsScenario()

      connectYjsServer()

      const doc = new Y.Doc()

      const client = makeClient(doc)

      client.on('status', (event: { status: string }) => {
        expect(event.status).toBe('connected')
        done()
      })
    }))

  test('connect after disconnect', async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    connectYjsServer()

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
    const { connectYjsServer, makeClient } = wsScenario()

    const logError = vi.fn()
    connectYjsServer({
      logger: makeLogger({ error: logError }),
      docNameFromRequest: (req) => (req.url?.includes('invalid') ? undefined : 'ok'),
    })

    const client = makeClient(new Y.Doc(), 'invalid')

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(false)
      expect(logError).toHaveBeenCalledOnce()
    })
  })

  test('syncs docs', async () => {
    const { connectYjsServer, makeClient } = wsScenario()
    connectYjsServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    await waitForAllSynced([makeClient(doc1), makeClient(doc2)])

    doc1.getMap('root').set('foo', 'bar')

    await waitForExpect(() => {
      expect(doc2.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    })

    doc2.getMap('root').set('foo2', 'bar2')

    await waitForExpect(() => {
      expect(doc1.getMap('root').toJSON()).toEqual({ foo: 'bar', foo2: 'bar2' })
    })
  })

  test('syncs separate room names', async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    connectYjsServer()

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
    const { connectYjsServer, makeClient } = wsScenario()

    connectYjsServer()

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

  test('syncs doc after a client joins late', async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    connectYjsServer()

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

  test(`closes existing connection and reject new ones`, async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    const server = connectYjsServer()

    const client1 = makeClient(new Y.Doc())

    await waitForAllSynced([client1])

    server.close(CloseReason.NORMAL)

    await waitForExpect(() => {
      expect(client1.wsconnected).toBe(false)
    })

    const client2 = makeClient(new Y.Doc())

    await waitForAllDisconnected([client2])

    expect(client2.wsconnected).toBe(false)

    // y-websocket will attempt an infinity reconnect loop, that's just how it is build
  })

  test(`ignores closed websockets`, async () => {
    const { wss, makeClient } = wsScenario()

    const warn = vi.fn()
    const server = createServer({
      createDoc: () => new Y.Doc(),
      logger: makeLogger({ warn }),
    })

    wss.once('connection', (ws, req) => {
      server.handleConnection(ws, req)
    })

    const doc = new Y.Doc()
    doc.getMap('root').set('foo', 'bar')
    const client = makeClient(doc)

    await waitForAllSynced([client])

    const nextConnectionEvent = new Promise<void>((resolve) => {
      wss.once('connection', (ws, req) => {
        ws.once('close', () => {
          server.handleConnection(ws, req)
        })
        ws.close()
        resolve()
      })
    })

    const doc2 = new Y.Doc()
    makeClient(doc2)

    await nextConnectionEvent

    wss.once('connection', (ws, req) => {
      server.handleConnection(ws, req)
    })

    const doc3 = new Y.Doc()
    makeClient(doc3)

    await waitForExpect(() => {
      expect(doc2.getMap('root').toJSON()).toEqual({})
      expect(doc3.getMap('root').toJSON()).toEqual({ foo: 'bar' })
      expect(warn).toHaveBeenCalledOnce()
    })
  })
})
