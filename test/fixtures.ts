import { WebSocket, WebSocketServer } from 'ws'
import { vi } from 'vitest'
import type { CreateYjsServerOptions } from '../src/index.js'
import { createYjsServer } from '../src/index.js'
import * as Y from 'yjs'
import type * as awarenessProtocol from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import type { Logger } from '../src/types.js'

let PORT_START = 9000 + (((Number.parseInt(process.env['VITEST_POOL_ID']!) - 1) * 20) % 500)

const getPort = () => PORT_START++

export const startedServers = new Set<WebSocketServer>()

export function wsScenario() {
  const port = getPort()
  const wss = new WebSocketServer({ port, clientTracking: true })
  const serverUrl = `ws://localhost:${port}`

  startedServers.add(wss)

  const makeYjsServer = (opts?: Partial<CreateYjsServerOptions>) => {
    return createYjsServer({
      createDoc: () => new Y.Doc(),
      ...opts,
      logger: opts?.logger ?? makeLogger(),
    })
  }

  const makeConnectedYjsServer = (opts?: Partial<CreateYjsServerOptions>) => {
    const server = makeYjsServer(opts)

    wss.on('connection', (ws, req) => {
      server.handleConnection(ws, req)
    })

    return server
  }

  const makeClient = (
    doc: Y.Doc,
    roomName = 'test',
    opts?: {
      connect?: boolean
      awareness?: awarenessProtocol.Awareness
      params?: Record<string, string>
      WebSocketPolyfill?: typeof WebSocket
      resyncInterval?: number
      maxBackoffTime?: number
      disableBc?: boolean
    },
  ) =>
    new WebsocketProvider(serverUrl, roomName, doc, {
      WebSocketPolyfill: WebSocket,
      disableBc: true,
      ...opts,
    })

  return {
    port,
    wss,
    serverUrl,
    makeYjsServer,
    makeConnectedYjsServer,
    makeClient,
  }
}

export const makeLogger = (overrides?: Partial<Logger>) => {
  const logger: Logger = {
    info: vi.fn(console.info),
    error: vi.fn((args, msg) => {
      if ('err' in args) throw new Error(msg, { cause: (args as { err: Error }).err })
      else throw new Error(msg)
    }),
    warn: vi.fn(console.warn),
    ...overrides,
  }

  return logger
}
