import type { DocStorage, IRequest, IWebSocket, Logger, MessageEvent, YjsServer } from './types.js'
import { CloseReason } from './types.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync.js'
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness.js'
import type { Room } from './Room.js'
import { makeRoom } from './Room.js'
import { keepAlive, send } from './socket-ops.js'
import { CLOSED, CLOSING, invariant, MessageType } from './internal.js'
import type { Doc } from 'yjs'

export const defaultDocNameFromRequest = (req: IRequest) => {
  return req.url?.slice(1).split('?')[0]
}

export interface CreateYjsServerOptions {
  createDoc: () => Doc
  logger?: Logger
  docNameFromRequest?: typeof defaultDocNameFromRequest
  docStorage?: DocStorage
  rooms?: Map<string, Room>
  pingTimeoutMs?: number
  maxBufferedBytes?: number
  maxBufferedBytesBeforeConnect?: number
}

export const createYjsServer = ({
  createDoc,
  docStorage,
  logger = console,
  docNameFromRequest = defaultDocNameFromRequest,
  rooms = new Map(),
  pingTimeoutMs = 30000,
  maxBufferedBytesBeforeConnect = 1024 * 5, // 5MB
  maxBufferedBytes = 1024 * 1024 * 100, // 100 MB
}: CreateYjsServerOptions): YjsServer => {
  let isClosed = false
  const alwaysConnect = Promise.resolve(true)

  const handleConnection = async (
    conn: IWebSocket,
    IRequest: IRequest,
    shouldConnect = alwaysConnect,
  ) => {
    const bufferedMessages = new Array<ArrayBuffer>()

    try {
      if (isClosed) {
        conn.close(CloseReason.NORMAL)
        return
      }

      if (conn.readyState === CLOSING || conn.readyState === CLOSED) {
        logger.warn(
          { IRequest, readyState: conn },
          'received a socket that is already closing or closed',
        )
        return
      }

      conn.binaryType = 'arraybuffer'

      // note: no async code should happen between bufferUntilReady calls, or we may lose messages
      const shouldContinue = await bufferUntilReady(
        conn,
        bufferedMessages,
        maxBufferedBytesBeforeConnect,
        shouldConnect,
        IRequest,
      )

      // shouldConnect parent should close the connection with the appropriate error code,
      // or we closed it due to a maxBufferedBytesBeforeConnect limit
      if (!shouldContinue) return
    } catch (err) {
      logger.error({ IRequest, err }, 'error handling new connection')
      conn.terminate()
      return
    }

    try {
      const docName = docNameFromRequest(IRequest)

      if (!docName) {
        conn.close(CloseReason.UNSUPPORTED)
        logger.error({ IRequest }, 'invalid doc name')
        return
      }

      const room = getOrCreateRoom(docName)

      const shouldContinue = await bufferUntilReady(
        conn,
        bufferedMessages,
        maxBufferedBytes,
        room.loadPromise,
        IRequest,
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
      logger.error({ IRequest, err }, 'error setting up new connection')
      conn.close(CloseReason.INTERNAL_ERROR)
    }
  }

  const bufferUntilReady = async (
    conn: IWebSocket,
    messages: ArrayBuffer[],
    maxSize: number,
    whenReady: Promise<boolean>,
    IRequest: IRequest,
  ) => {
    let size = messages.reduce((acc, msg) => acc + msg.byteLength, 0)

    const onMessage = ({ data }: MessageEvent) => {
      if (conn.readyState === CLOSING || conn.readyState === CLOSED) return

      if (data instanceof ArrayBuffer) {
        size += data.byteLength

        if (size <= maxSize) {
          messages.push(data)
        } else {
          logger.warn({ IRequest, size, maxSize }, 'message buffer exceeded maxSize')
          conn.terminate()
        }
      } else {
        logger.warn({ IRequest }, 'received a non-arraybuffer message')
        conn.terminate()
      }
    }
    conn.addEventListener('message', onMessage)

    let removeCloseListener: (() => void) | undefined
    const connectionClosed = new Promise<false>((resolve) => {
      const onClose = () => {
        messages.length = 0
        resolve(false)
      }
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

  const setupNewConnection = (room: Room, conn: IWebSocket) => {
    invariant(conn.readyState === 1, 'socket should be open')
    room.addConnection(conn)

    conn.addEventListener('close', () => {
      handleClose(conn, room)
    })

    const handleMessage = ({ data }: MessageEvent) => {
      try {
        if (conn.readyState === CLOSING || conn.readyState === CLOSED) return

        if (data instanceof ArrayBuffer) {
          handleMessageImpl(conn, room, new Uint8Array(data))
        } else {
          logger.error({ conn, dataTye: typeof data }, 'received a non-arraybuffer message')
          conn.close(CloseReason.UNSUPPORTED)
        }
      } catch (err) {
        logger.error({ err }, 'error handling message')
        conn.close(CloseReason.UNSUPPORTED)
      }
    }
    conn.addEventListener('message', handleMessage)

    keepAlive(conn, pingTimeoutMs, logger)

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

  const handleClose = (conn: IWebSocket, room: Room): void => {
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
    handleConnection(...args) {
      // don't expose the promise in the public API for now
      // this promise should never throw
      void handleConnection(...args)
    },
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
      throw new Error('unsupported message type')
  }
}
