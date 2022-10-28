import { describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { waitForDisconnectEvent, waitForExpect, waitForSyncEvent } from './test-utils.js'
import { Awareness } from 'y-protocols/awareness.js'
import { makeLogger, wsScenario } from './fixtures.js'
import { CloseReason } from '../src/types.js'
import { createYjsServer } from '../src/index.js'

describe.concurrent('server', () => {
  test('client connects', () =>
    new Promise<void>((done) => {
      const { makeConnectedYjsServer, makeClient } = wsScenario()

      makeConnectedYjsServer()

      const doc = new Y.Doc()

      const client = makeClient(doc)

      client.on('status', (event: { status: string }) => {
        expect(event.status).toBe('connected')
        done()
      })
    }))

  test('connects after disconnect', async () => {
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    makeConnectedYjsServer()

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
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    const logError = vi.fn()
    makeConnectedYjsServer({
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
    const { makeConnectedYjsServer, makeClient } = wsScenario()
    makeConnectedYjsServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    await waitForSyncEvent([makeClient(doc1), makeClient(doc2)])

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
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    makeConnectedYjsServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()
    const doc3 = new Y.Doc()
    const doc4 = new Y.Doc()

    await waitForSyncEvent([
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
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    makeConnectedYjsServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    const awareness1 = new Awareness(doc1)
    const awareness2 = new Awareness(doc2)

    await waitForSyncEvent([
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

  test('syncs existing awareness', async () => {
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    makeConnectedYjsServer()

    const doc1 = new Y.Doc()
    const awareness1 = new Awareness(doc1)
    const client1 = makeClient(doc1, 'room1', { awareness: awareness1 })

    awareness1.setLocalState({ user: 'jonny' })

    await waitForExpect(() => {
      expect(client1.synced).toBe(true)
    })

    const doc2 = new Y.Doc()
    const awareness2 = new Awareness(doc2)
    awareness2.setLocalState(null)
    const client2 = makeClient(doc2, 'room1', { awareness: awareness2 })

    await waitForExpect(() => {
      expect(client2.synced).toBe(true)
    })

    await waitForExpect(() => {
      expect([...awareness2.getStates().values()]).toEqual([{ user: 'jonny' }])
    })
  })

  test('syncs doc after a client joins later', async () => {
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    makeConnectedYjsServer()

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    doc1.getMap('root').set('foo', 'bar')

    const client1 = makeClient(doc1)
    const client2 = makeClient(doc2)

    await waitForSyncEvent([client1, client2])

    await waitForExpect(() => {
      expect(doc2.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    })

    const doc3 = new Y.Doc()
    makeClient(doc3)

    await waitForExpect(() => {
      expect(doc3.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    })
  })

  test(`ignores closed websockets`, async () => {
    const { wss, makeClient } = wsScenario()

    const warn = vi.fn()
    const server = createYjsServer({
      createDoc: () => new Y.Doc(),
      logger: makeLogger({ warn }),
    })

    wss.once('connection', (ws, req) => {
      server.handleConnection(ws, req)
    })

    const doc = new Y.Doc()
    doc.getMap('root').set('foo', 'bar')
    const client = makeClient(doc)

    await waitForSyncEvent([client])

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

  test('terminates connection if docNameFromRequest throws', async () => {
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    const err = new Error('docNameFromRequest error')
    const logError = vi.fn()

    makeConnectedYjsServer({
      logger: makeLogger({ error: logError }),
      docNameFromRequest: () => {
        throw err
      },
    })

    const client = makeClient(new Y.Doc())

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(false)
      expect(logError).toHaveBeenCalledOnce()
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        expect.stringMatching(/error setting up new connection/),
      )
    })
  })

  test('terminates connection on string message', async () => {
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    const logError = vi.fn()
    makeConnectedYjsServer({
      logger: makeLogger({ error: logError }),
    })

    const client = makeClient(new Y.Doc())

    await waitForExpect(() => {
      expect(client.synced).toBe(true)
    })

    client.ws.send('invalid message')
    client.ws.send('invalid message twp')

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(false)
      expect(logError).toHaveBeenCalledOnce()
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({}),
        expect.stringMatching(/received a non-arraybuffer message/),
      )
    })
  })

  test('terminates connection on invalid message type', async () => {
    const { makeConnectedYjsServer, makeClient } = wsScenario()

    const logError = vi.fn()
    makeConnectedYjsServer({
      logger: makeLogger({ error: logError }),
    })

    const client = makeClient(new Y.Doc())

    await waitForExpect(() => {
      expect(client.synced).toBe(true)
    })

    client.ws.send(new Uint8Array([22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(false)
      expect(logError).toHaveBeenCalledOnce()
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringMatching(/error handling message/),
      )
    })
  })

  test(`closing server closes existing connection and reject new ones`, async () => {
    const { wss, makeConnectedYjsServer, makeClient } = wsScenario()

    const server = makeConnectedYjsServer()

    const client1 = makeClient(new Y.Doc())

    await waitForSyncEvent([client1])

    await waitForExpect(() => {
      expect(wss.clients.size).toBe(1)
    })

    server.close(CloseReason.NORMAL)

    await waitForExpect(() => {
      expect(client1.wsconnected).toBe(false)
      expect(wss.clients.size).toBe(0)
    })

    const client2 = makeClient(new Y.Doc())

    await waitForDisconnectEvent([client2])
    // y-websocket will attempt an infinity reconnect loop, that's just how it is build

    // should not throw once closed
    server.close()
  })

  test(`closing server with terminate timeout`, async () => {
    const { wss, makeYjsServer, makeClient } = wsScenario()

    const server = makeYjsServer()

    const close = vi.fn()
    wss.once('connection', (ws, req) => {
      ws.close = close
      server.handleConnection(ws, req)
    })

    const client1 = makeClient(new Y.Doc())
    client1.on('connection-close', () => {
      client1.shouldConnect = false
    })

    await waitForExpect(() => {
      expect(client1.synced).toBe(true)
    })

    expect(wss.clients.size).toBe(1)

    server.close(CloseReason.NORMAL, 100)
    expect(close).toHaveBeenCalledOnce()

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(wss.clients.size).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(wss.clients.size).toBe(0)
  })
})
