import { YjsServerError } from './error.js'
import type { DocStorage, IRequest, IWebSocket, Logger, WebsSocketData } from './types.js'
import { CloseReason, MessageType } from './types.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync.js'
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import { Room } from './Room.js'
import { keepAlive, send } from './socket-ops.js'

export const defaultDocNameFromRequest = <Req extends IRequest>(req: Req) => {
  return req.url?.slice(1).split('?')[0]
}

export interface CreateServerOptions<WS extends IWebSocket = IWebSocket> {
  logger?: Logger
  docNameFromRequest?: typeof defaultDocNameFromRequest
  docStorage?: DocStorage
  rooms?: Map<string, Room>
  roomOfConnection?: WeakMap<WS, Room>
  pingTimeout?: number
}

export function createServer<WS extends IWebSocket = IWebSocket, Req extends IRequest = IRequest>({
  logger = console,
  docNameFromRequest = defaultDocNameFromRequest,
  docStorage,
  rooms = new Map(),
  roomOfConnection = new WeakMap(),
  pingTimeout = 30000,
}: CreateServerOptions<WS>) {
  // this function can never be async without having to synchronize future incoming messages
  const handleConnection = (conn: WS, req: Req) => {
    const docName = docNameFromRequest(req)

    if (typeof docName !== 'string' || !docName) {
      conn.close(CloseReason.CLOSE_UNSUPPORTED)
      logger.error({ req }, 'invalid doc name')
      return
    }

    conn.binaryType = 'arraybuffer'

    const room = getOrInitRoom(docName)

    try {
      setupNewConnection(room, conn)
    } catch (err) {
      logger.error({ req, err }, 'error handling new connection')
      conn.close(CloseReason.INTERNAL_ERROR)
    }
  }

  const setupNewConnection = (room: Room, conn: WS) => {
    room.addConnection(conn)
    roomOfConnection.set(conn, room)

    conn.on('close', () => {
      handleClose(conn)
    })

    conn.on('message', (message: WebsSocketData) => {
      try {
        handleMessage(conn, room, new Uint8Array(message as ArrayBuffer))
      } catch (err) {
        logger.error({ err }, 'error handling message')
        conn.close(CloseReason.CLOSE_UNSUPPORTED)
      }
    })

    keepAlive(conn, pingTimeout, logger)

    sendSyncStepOne(conn, room)
  }

  const getOrInitRoom = (name: string) => {
    const existing = rooms.get(name)

    if (existing) return existing

    const room = new Room(name, docStorage, logger)

    rooms.set(name, room)

    return room
  }

  const handleClose = (conn: WS): void => {
    const room = roomOfConnection.get(conn)

    if (room) {
      room.removeConnection(conn)

      if (room.numConnections === 0) {
        rooms.delete(room.name)
        room.destroy()
      }
    }
  }

  const close = (code = CloseReason.CLOSE_NORMAL) => {
    for (const room of rooms.values()) {
      for (const conn of room.connections) {
        conn.close(code)
      }
    }
  }

  return {
    handleConnection,
    close,
  }
}

const sendSyncStepOne = (conn: IWebSocket, room: Room) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MessageType.Sync)
  syncProtocol.writeSyncStep1(encoder, room.yDoc)
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
    case MessageType.Sync: {
      encoding.writeVarUint(encoder, MessageType.Sync)
      syncProtocol.readSyncMessage(decoder, encoder, doc.yDoc, conn)

      // If the `encoder` only contains the type of reply message and no
      // message, there is no need to send the message. When `encoder` only
      // contains the type of reply, its length is 1.
      if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))

      break
    }

    case MessageType.Awareness: {
      const update = decoding.readVarUint8Array(decoder)
      applyAwarenessUpdate(doc.awareness, update, conn)
      break
    }

    default:
      throw new YjsServerError('unknown message type')
  }
}
