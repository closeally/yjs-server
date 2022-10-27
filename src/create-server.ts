import { YjsServerError } from './error.js'
import type {
  DocStorage,
  IRequest,
  IWebSocket,
  Logger,
  WebsSocketData,
  YjsServer,
} from './types.js'
import { CloseReason } from './types.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync.js'
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import type { Room } from './Room.js'
import { makeRoom } from './Room.js'
import { keepAlive, send } from './socket-ops.js'
import { CLOSED, CLOSING, MessageType, OPEN } from './internal.js'
import type { Doc } from 'yjs'

export const defaultDocNameFromRequest = <Req extends IRequest>(req: Req) => {
  return req.url?.slice(1).split('?')[0]
}

export interface CreateServerOptions<WS extends IWebSocket = IWebSocket> {
  createDoc: () => Doc
  logger?: Logger
  docNameFromRequest?: typeof defaultDocNameFromRequest
  docStorage?: DocStorage
  rooms?: Map<string, Room>
  pingTimeout?: number
}

export const createServer = <WS extends IWebSocket = IWebSocket, Req extends IRequest = IRequest>({
  createDoc,
  docStorage,
  logger = console,
  docNameFromRequest = defaultDocNameFromRequest,
  rooms = new Map(),
  pingTimeout = 30000,
}: CreateServerOptions<WS>): YjsServer<WS, Req> => {
  let isClosed = false
  const alwaysConnect = Promise.resolve(true)

  // note: all handlers need to be attached to the socket ASAP, otherwise we might miss events
  // this complicates the code a bit, but it's necessary due to how the y-websocket client works
  const handleConnection = (conn: WS, req: Req, shouldConnect = alwaysConnect) => {
    if (isClosed || conn.readyState === CLOSING || conn.readyState === CLOSED) return

    try {
      const docName = docNameFromRequest(req)

      if (!docName) {
        conn.close(CloseReason.UNSUPPORTED)
        logger.error({ req }, 'invalid doc name')
        return
      }

      conn.binaryType = 'arraybuffer'

      const [room, loadDoc] = getOrCreateRoom(docName)

      const readyPromise = loadDoc
        ? // only load the room after shouldConnect resolves, if the connection is dropped, the room
          // won't load, avoiding a potential DoS vector
          // if the connection is dropped, the room will be cleaned up by the close handler
          whenReady(conn, shouldConnect, loadDoc)
        : shouldConnect

      setupNewConnection(room, conn, readyPromise)
    } catch (err) {
      logger.error({ req, err }, 'error handling new connection')
      conn.close(CloseReason.INTERNAL_ERROR)
    }
  }

  const setupNewConnection = (room: Room, conn: WS, readyPromise: Promise<boolean>) => {
    // setup close handler and keep alive ASAP, these don't depend on auth or doc loading
    conn.on('close', () => {
      handleClose(conn, room)
    })

    keepAlive(conn, pingTimeout, logger)

    // even if the authorization is still in progress, we need to listen for messages ASAP
    // the y-websocket library will send a sync step 1 message immediately after connecting
    conn.on('message', (message: WebsSocketData) => {
      // multiple messages will be enqueued by the js runtime until the readyPromise resolves
      // note: accumulating too many unauthorized messages could be a potential DoS vector
      void whenReady(conn, readyPromise, () => {
        try {
          handleMessage(conn, room, new Uint8Array(message as ArrayBuffer))
        } catch (err) {
          logger.error({ err }, 'error handling message')
          conn.close(CloseReason.UNSUPPORTED)
        }
      })
      // if the connection is dropped, the messages will be discarded
    })

    void whenReady(conn, readyPromise, () => {
      // don't add the connection right away, or the connection could receive messages before it's authorized
      room.addConnection(conn)

      // besides auth, make sure contents of the doc had been loaded from docStorage
      // this ensures the initial sync the client receive is up-to-date, avoiding intermediate states
      sendSyncStepOne(conn, room)
    })
    // if the connection is dropped, there is nothing to clean up
  }

  const getOrCreateRoom = (name: string) => {
    const existing = rooms.get(name)

    if (existing) return [existing, undefined] as const

    const [room, loadDoc] = makeRoom(name, createDoc(), docStorage, logger)

    rooms.set(name, room)

    return [room, loadDoc] as const
  }

  const handleClose = (conn: WS, room: Room): void => {
    // connection might not be on the room if it was dropped before shouldConnect/docLoad
    room.removeConnection(conn)

    // still, if the room just loaded and the connection dropped, we need to clean up
    if (room.numConnections === 0) {
      rooms.delete(room.name)
      room.destroy()
    }
  }

  const close = (code: number = CloseReason.NORMAL, terminateTimeout: number | null = null) => {
    if (isClosed) return

    isClosed = true

    const allRooms = [...rooms.values()]
    for (const room of allRooms) {
      for (const conn of room.connections) {
        conn.close(code)
      }
    }

    rooms.clear()

    if (typeof terminateTimeout === 'number') {
      setTimeout(() => {
        for (const room of allRooms) {
          for (const conn of room.connections) {
            conn.terminate()
          }
        }
      }, terminateTimeout)
    }
  }

  const whenReady = async <T>(
    conn: WS,
    promise: Promise<boolean>,
    next: () => T,
  ): Promise<boolean | Awaited<T>> => {
    const shouldContinue = await promise

    if (!shouldContinue || isClosed || conn.readyState !== OPEN) return false

    return next() as Awaited<T>
  }

  return {
    handleConnection,
    close,
  }
}

const sendSyncStepOne = (conn: IWebSocket, room: Room) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MessageType.Sync)
  writeSyncStep1(encoder, room.yDoc)
  send(conn, encoding.toUint8Array(encoder))

  const awarenessStates = room.awareness.getStates()

  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MessageType.Awareness)
    encoding.writeVarUint8Array(
      encoder,
      encodeAwarenessUpdate(room.awareness, Array.from(awarenessStates.keys())),
    )
    send(conn, encoding.toUint8Array(encoder))
  }
}

const handleMessage = (conn: IWebSocket, doc: Room, message: Uint8Array) => {
  const encoder = encoding.createEncoder()
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)

  // message updates will trigger update events inside the room, which Room handles
  switch (messageType) {
    case MessageType.Sync:
      encoding.writeVarUint(encoder, MessageType.Sync)
      readSyncMessage(decoder, encoder, doc.yDoc, null)

      // If the `encoder` only contains the type of reply message and no
      // message, there is no need to send the message. When `encoder` only
      // contains the type of reply, its length is 1.
      if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))

      break

    case MessageType.Awareness: {
      const update = decoding.readVarUint8Array(decoder)
      applyAwarenessUpdate(doc.awareness, update, conn)
      break
    }

    default:
      throw new YjsServerError('unknown message type')
  }
}
