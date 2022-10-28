import { describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { waitForAllDisconnected, waitForExpect } from './test-utils.js'
import { makeLogger, wsScenario } from './fixtures.js'

describe.concurrent('server storage', () => {
  test('loads existing doc after a delay', async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    connectYjsServer({
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
      },
    })

    const doc = new Y.Doc()
    makeClient(doc, 'room_123')

    await waitForExpect(() => {
      expect(doc.getArray('root').toJSON()).toEqual(['existing', 'doc'])
    })
  })

  test('loads existing doc fast', async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    connectYjsServer({
      docStorage: {
        loadDoc(name, doc) {
          const existingDoc = new Y.Doc()
          existingDoc.getArray('root').push(['existing', 'doc'])

          Y.applyUpdate(doc, Y.encodeStateAsUpdate(existingDoc))
          return Promise.resolve()
        },
      },
    })

    const doc = new Y.Doc()
    makeClient(doc, 'room_123')

    await waitForExpect(() => {
      expect(doc.getArray('root').toJSON()).toEqual(['existing', 'doc'])
    })
  })

  test('disconnect clients if room fails to load', async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    const loadError = new Error('failed to load')

    const logError = vi.fn()
    const roomFailsToLoad = new Promise((resolve) => {
      connectYjsServer({
        logger: makeLogger({ error: logError }),
        docStorage: {
          loadDoc() {
            setTimeout(resolve)
            return new Promise((_, reject) => {
              setTimeout(() => reject(loadError), 50)
            })
          },
        },
      })
    })

    const doc = new Y.Doc()
    const client = makeClient(doc)

    // the client connects and sends sync step 1, etc
    await waitForExpect(() => {
      expect(client.wsconnected).toBe(true)
    })

    // all client frames are buffered waiting for the room, and suddenly the room fails to load
    await roomFailsToLoad

    await waitForExpect(() => {
      expect(client.wsconnected).toBe(false)
      expect(logError).toHaveBeenCalledOnce()
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ err: loadError }),
        expect.stringMatching(/loadDoc failed/),
      )
    })
  })

  test('stores doc after last client disconnects', async () => {
    const { connectYjsServer, makeClient } = wsScenario()

    const storeDoc = vi.fn(() => Promise.resolve())

    connectYjsServer({
      docStorage: {
        loadDoc: vi.fn(() => Promise.resolve()),
        storeDoc,
      },
    })

    const doc1 = new Y.Doc()
    doc1.getMap('root').set('foo', 'bar')
    const client1 = makeClient(doc1, 'room_123')

    const doc2 = new Y.Doc()
    const client2 = makeClient(doc2, 'room_123')

    await waitForExpect(() => {
      expect(doc2.getMap('root').toJSON()).toEqual({ foo: 'bar' })
    })

    client1.disconnect()

    await waitForAllDisconnected([client1], 50)

    expect(storeDoc).not.toHaveBeenCalled()

    client2.disconnect()

    await waitForAllDisconnected([client2], 50)

    expect(storeDoc).toHaveBeenCalledOnce()
    expect(storeDoc).toHaveBeenCalledWith('room_123', expect.any(Y.Doc))
  })
})
