import { YjsServerError } from './error.js'
import type { DocStorage, IRequest, IWebSocket, Logger, MessageEvent, YjsServer } from './types.js'
import { CloseReason } from './types.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync.js'
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import type { Room } from './Room.js'
import { makeRoom } from './Room.js'
import { keepAlive, send } from './socket-ops.js'
import { CLOSED, CLOSING, MessageType } from './internal.js'
import type { Doc } from 'yjs'

export const defaultDocNameFromRequest = <Req extends IRequest>(req: Req) => {
  return req.url?.slice(1).split('?')[0]
}

export interface CreateServerOptions {
  createDoc: () => Doc
  logger?: Logger
  docNameFromRequest?: typeof defaultDocNameFromRequest
  docStorage?: DocStorage
  rooms?: Map<string, Room>
  pingTimeout?: number
  maxBufferedBytes?: number
  maxBufferedBytesBeforeConnect?: number
}

export const createServer = <WS extends IWebSocket = IWebSocket, Req extends IRequest = IRequest>({
  createDoc,
  docStorage,
  logger = console,
  docNameFromRequest = defaultDocNameFromRequest,
  rooms = new Map(),
  pingTimeout = 30000,
  maxBufferedBytesBeforeConnect = 1024 * 10,
  maxBufferedBytes = 1024 * 100,
}: CreateServerOptions): YjsServer<WS, Req> => {
  let isClosed = false
  const alwaysConnect = Promise.resolve(true)

  const handleConnection = async (conn: WS, req: Req, shouldConnect = alwaysConnect) => {
    if (isClosed) return

    if (conn.readyState === CLOSING || conn.readyState === CLOSED) {
      logger.warn({ req, readyState: conn }, 'received a socket that is already closing or closed')
      return
    }

    const bufferedMessages = new Array<ArrayBuffer>()
    try {
      conn.binaryType = 'arraybuffer'

      // note: no async code should happen between bufferUntilReady calls, or we may lose messages
      const shouldContinue = await bufferUntilReady(
        conn,
        bufferedMessages,
        maxBufferedBytesBeforeConnect,
        shouldConnect,
        req,
      )

      // shouldConnect parent should close the connection with the appropriate error code
      if (!shouldContinue) return
    } catch (err) {
      logger.error({ req, err }, 'error handling new connection')
      conn.terminate()
    }

    try {
      const docName = docNameFromRequest(req)

      if (!docName) {
        conn.close(CloseReason.UNSUPPORTED)
        logger.error({ req }, 'invalid doc name')
        return
      }

      const room = getOrCreateRoom(docName)

      const shouldContinue = await bufferUntilReady(
        conn,
        bufferedMessages,
        maxBufferedBytes,
        room.loadPromise,
        req,
      )

      // room failed to load or the socket was closed
      if (!shouldContinue) {
        conn.close(CloseReason.INTERNAL_ERROR)
        return
      }

      const handleMessage = setupNewConnection(room, conn)

      // replay buffered messages
      bufferedMessages.forEach((data) => handleMessage({ data }))
    } catch (err) {
      logger.error({ req, err }, 'error handling new connection')
      conn.close(CloseReason.INTERNAL_ERROR)
    }
  }

  const bufferUntilReady = async (
    conn: WS,
    messages: ArrayBuffer[],
    maxSize: number,
    whenReady: Promise<boolean>,
    req: Req,
  ) => {
    let size = messages.reduce((acc, msg) => acc + msg.byteLength, 0)

    const onMessage = ({ data }: MessageEvent) => {
      if (data instanceof ArrayBuffer) {
        size += data.byteLength

        if (size <= maxSize) {
          messages.push(data)
        } else {
          logger.warn({ req, size, maxSize }, 'message buffer exceeded maxSize')
          conn.terminate()
        }
      } else {
        logger.warn({ req }, 'received a non-arraybuffer message')
        conn.terminate()
      }
    }
    conn.addEventListener('message', onMessage)

    let removeCloseListener: (() => void) | undefined
    const connectionClosed = new Promise<false>((resolve) => {
      const onClose = () => resolve(false)
      conn.addEventListener('close', onClose)
      removeCloseListener = () => conn.removeEventListener('close', onClose)
    })

    try {
      return await Promise.race([connectionClosed, whenReady])
    } finally {
      removeCloseListener?.()
      conn.removeEventListener('message', onMessage)
    }
  }

  const setupNewConnection = (room: Room, conn: WS) => {
    room.addConnection(conn)

    conn.addEventListener('close', () => {
      handleClose(conn, room)
    })

    const handleMessage = ({ data }: MessageEvent) => {
      try {
        handleMessageImpl(conn, room, new Uint8Array(data as ArrayBuffer))
      } catch (err) {
        logger.error({ err }, 'error handling message')
        conn.close(CloseReason.UNSUPPORTED)
      }
    }
    conn.addEventListener('message', handleMessage)

    keepAlive(conn, pingTimeout, logger)

    sendSyncStepOne(conn, room)

    return handleMessage
  }

  const getOrCreateRoom = (name: string) => {
    const existing = rooms.get(name)

    if (existing) return existing

    const room = makeRoom(name, createDoc(), docStorage, logger)

    rooms.set(name, room)

    return room
  }

  const handleClose = (conn: WS, room: Room): void => {
    room.removeConnection(conn)

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

const handleMessageImpl = (conn: IWebSocket, doc: Room, message: Uint8Array) => {
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
