import type { DocStorage, IWebSocket, Logger } from './types.js'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import { removeAwarenessStates } from 'y-protocols/awareness'
import { send } from './socket-ops.js'
import * as syncProtocol from 'y-protocols/sync.js'
import { encoding } from 'lib0'
import { MessageType } from './internal.js'
import type { Doc } from 'yjs'

export const makeRoom = (
  name: string,
  yDoc: Doc,
  docStorage: DocStorage | undefined,
  logger: Logger,
) => {
  const room = new Room(name, yDoc, docStorage, logger)

  const docLoader = docStorage?.loadDoc

  // load an existing document from persistent storage
  const loadDoc = docLoader
    ? () =>
        docLoader(name, room.yDoc)
          .then(() => true)
          .catch((err: unknown) => {
            // room.connections.size should be 0
            logger.error({ name, err }, 'error loading Y.Doc, closing all connections')
            return false
          })
    : undefined

  return [room, loadDoc] as const
}

export class Room {
  public readonly awareness

  // maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
  private readonly conns = new Map<IWebSocket, Set<number>>()
  private readonly handleDocUpdate: (update: Uint8Array, origin: unknown) => void
  private isDirty = false

  constructor(
    public readonly name: string,
    public readonly yDoc: Doc,
    private readonly docStorage: DocStorage | undefined,
    private readonly logger: Logger,
  ) {
    this.awareness = new Awareness(yDoc)
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

      docStorage?.onUpdate?.(name, update, this.yDoc).catch((err) => {
        logger.warn({ name, err, yDoc: this.yDoc }, 'error calling onUpdate')
      })

      this.isDirty = true
    }

    this.yDoc.on('update', this.handleDocUpdate)
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

    if (this.isDirty && this.docStorage?.storeDoc) {
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
