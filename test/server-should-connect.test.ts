import { describe, expect, test } from 'vitest'
import { wsScenario } from './fixtures.js'
import * as Y from 'yjs'
import { waitForExpect } from './test-utils.js'
import { OPEN } from '../src/internal.js'

describe.concurrent('server shouldConnect', () => {
  test('waits to sync docs after shouldConnect', async () => {
    const { wss, makeYjsServer, makeClient } = wsScenario()

    let proceedWithConnection!: (v: boolean) => void
    const shouldConnect = new Promise<boolean>((resolve) => {
      proceedWithConnection = resolve
    })

    const server = makeYjsServer()
    wss.on('connection', (conn, req) => {
      server.handleConnection(conn, req, shouldConnect)
    })

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    doc1.getMap('root').set('foo', 'bar')

    const client1 = makeClient(doc1)
    const client2 = makeClient(doc2)

    await waitForExpect(() => {
      expect(client1.wsconnected).toBe(true)
      expect(client2.wsconnected).toBe(true)
      expect(doc2.getMap('root').toJSON()).toEqual({})
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    doc2.getMap('root').set('foo2', 'bar2')

    expect(client1.synced).toBe(false)
    expect(client2.synced).toBe(false)
    expect(doc1.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    expect(doc2.getMap('root').toJSON()).toEqual({ foo2: 'bar2' })

    proceedWithConnection(true)

    await waitForExpect(() => {
      expect(client1.synced).toBe(true)
      expect(client2.synced).toBe(true)
      expect(doc1.getMap('root').toJSON()).toEqual({ foo: 'bar', foo2: 'bar2' })
      expect(doc2.getMap('root').toJSON()).toEqual({ foo: 'bar', foo2: 'bar2' })
    })
  })

  test('does not closes socket if shouldConnect returns false', async () => {
    const { wss, makeYjsServer, makeClient } = wsScenario()

    const CLOSE_CODE = 4001

    let closeConnection!: () => void
    const shouldConnect = Promise.resolve(false)

    const server = makeYjsServer()
    wss.on('connection', (conn, req) => {
      server.handleConnection(conn, req, shouldConnect)

      void shouldConnect.then(() => {
        closeConnection = () => conn.close(CLOSE_CODE)
        expect(conn.readyState).toBe(OPEN)
      })
    })

    const client = makeClient(new Y.Doc())
    const connectionClose = new Promise<unknown>((resolve) => {
      client.once('connection-close', (ev: unknown) => {
        resolve(ev)
      })
    })

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(true)
    })

    closeConnection()
    const closeEvent = await connectionClose

    expect((closeEvent as { code: number }).code).toBe(CLOSE_CODE)
  })

  test('awaiting shouldConnect socket does not interfere with room updates', async () => {
    const { wss, makeYjsServer, makeClient } = wsScenario()

    let shouldConnect = Promise.resolve(true)

    const server = makeYjsServer()
    wss.on('connection', (conn, req) => {
      void shouldConnect.then((should) => {
        if (!should) conn.close(4001)
      })
      server.handleConnection(conn, req, shouldConnect)
    })

    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    doc1.getMap('root').set('doc1_start', true)

    const client1 = makeClient(doc1)
    const client2 = makeClient(doc2)

    await waitForExpect(() => {
      expect(client1.synced).toBe(true)
      expect(client2.synced).toBe(true)
    })

    let resolveShouldConnect!: (v: boolean) => void
    shouldConnect = new Promise<boolean>((resolve) => {
      resolveShouldConnect = resolve
    })

    const doc3 = new Y.Doc()
    const client3 = makeClient(doc3)

    doc3.getMap('root').set('doc3_start', true)

    await waitForExpect(() => {
      expect(client3.wsconnected).toBe(true)
    })

    doc1.getMap('root2').set('doc1_change1', true)
    doc2.getMap('root').set('doc2_change1', true)
    doc2.getMap('root2').set('doc2_change2', true)

    await waitForExpect(() => {
      expect(doc1.getMap('root').toJSON()).toEqual({ doc1_start: true, doc2_change1: true })
      expect(doc1.getMap('root2').toJSON()).toEqual({ doc1_change1: true, doc2_change2: true })
      expect(doc3.getMap('root').toJSON()).toEqual({ doc3_start: true })
      expect(client3.synced).toBe(false)
    })

    resolveShouldConnect(false)

    doc3.getMap('root').delete('doc3_start')

    await waitForExpect(() => {
      expect(client3.wsconnected).toBe(false)
    })

    await waitForExpect(() => {
      expect(doc1.getMap('root').toJSON()).toEqual({ doc1_start: true, doc2_change1: true })
      expect(doc1.getMap('root2').toJSON()).toEqual({ doc1_change1: true, doc2_change2: true })
      expect(doc3.getMap('root').toJSON()).toEqual({})
    })

    shouldConnect = Promise.resolve(true)

    client3.connect()

    await waitForExpect(() => {
      expect(client3.synced).toBe(true)
    })

    doc3.getMap('root').clear()

    await waitForExpect(() => {
      expect(doc1.getMap('root').toJSON()).toEqual({})
      expect(doc2.getMap('root').toJSON()).toEqual({})
      expect(doc3.getMap('root').toJSON()).toEqual({})
    })
  })
})
