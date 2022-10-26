import type { DocStorage, IWebSocket, Logger } from './types.js'
import { CloseReason, MessageType } from './types.js'
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import { removeAwarenessStates } from 'y-protocols/awareness'
import { send } from './socket-ops.js'
import * as syncProtocol from 'y-protocols/sync.js'
import { encoding } from 'lib0'

export class Room {
  public readonly yDoc = new Y.Doc()
  public readonly awareness = new Awareness(this.yDoc)

  // maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
  private readonly conns = new Map<IWebSocket, Set<number>>()
  private readonly handleDocUpdate: (update: Uint8Array, origin: unknown) => void

  constructor(
    public readonly name: string,
    private readonly docStorage: DocStorage | undefined,
    private readonly logger: Logger,
  ) {
    this.awareness.setLocalState(null)

    const handleAwarenessUpdate = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      conn: unknown,
    ) => {
      const changedClients = added.concat(updated, removed)

      const connControlledIds = this.conns.get(conn as IWebSocket)

      if (connControlledIds) {
        added.forEach((clientId) => {
          connControlledIds.add(clientId)
        })
        removed.forEach((clientId) => {
          connControlledIds.delete(clientId)
        })
      }

      // broadcast awareness update
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MessageType.Awareness)
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changedClients))
      const buff = encoding.toUint8Array(encoder)
      this.conns.forEach((_, c) => {
        send(c, buff)
      })
    }

    this.awareness.on('update', handleAwarenessUpdate)

    // broadcast updates
    this.handleDocUpdate = (update) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MessageType.Sync)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      this.conns.forEach((_, conn) => send(conn, message))

      docStorage?.storeUpdate?.(name, update, this.yDoc).catch((err) => {
        logger.warn({ name, err, yDoc: this.yDoc }, 'error calling storeUpdate')
      })
    }

    this.yDoc.on('update', this.handleDocUpdate)

    // load an existing document from persistent storage, but don't wait for it
    // if we were to wait, a race condition occurs while the document is loading:
    // Client(Connect) -> Server(wait for loadDoc...) -> Client(sync) -> Server(Responds Sync OK) -> Server(Loaded)
    // this would result in the client not having a fully synced document
    // after the doc loads, updates will be sent to clients automatically
    docStorage?.loadDoc(name, this.yDoc).catch((err: unknown) => {
      logger.error({ name, err }, 'error loading Y.Doc, closing all connections')

      // remove all connections, the room will close after the last connection is closed
      for (const conn of this.connections) {
        conn.close(CloseReason.INTERNAL_ERROR)
      }
    })
  }

  get numConnections() {
    return this.conns.size
  }

  get connections() {
    return this.conns.keys()
  }

  addConnection(conn: IWebSocket) {
    this.conns.set(conn, new Set())
  }

  removeConnection(conn: IWebSocket) {
    const controlledIds = this.conns.get(conn)

    if (controlledIds) {
      removeAwarenessStates(this.awareness, Array.from(controlledIds), null)
      this.conns.delete(conn)
    }
  }

  destroy() {
    this.yDoc.off('update', this.handleDocUpdate)
    this.awareness.destroy()

    if (this.docStorage?.storeDoc) {
      this.docStorage
        .storeDoc(this.name, this.yDoc)
        .catch((err: unknown) => {
          this.logger.warn({ name: this.name, err, yDoc: this.yDoc }, 'error calling storeDoc')
        })
        .finally(() => {
          this.yDoc.destroy()
        })
    } else {
      this.yDoc.destroy()
    }
  }
}
