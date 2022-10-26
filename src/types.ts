import type { createServer } from './create-server.js'
import type * as Y from 'yjs'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'

export type LogFn = <T extends object>(obj: T, msg: string, ...args: unknown[]) => void

export interface Logger {
  info: LogFn
  error: LogFn
  warn: LogFn
}

export interface WebSocketServer<WS extends IWebSocket> {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    upgradeHead: Buffer,
    callback: (client: WS, request: IncomingMessage) => void,
  ): void

  on(
    event: 'connection',
    cb: (this: WebSocketServer<WS>, socket: WS, request: IncomingMessage) => void,
  ): WebSocketServer<WS>

  emit(eventName: string | symbol, ...args: unknown[]): boolean
}

export interface IWebSocket {
  binaryType: 'arraybuffer' | string

  readonly readyState: number
  close(code?: number, data?: string | Buffer): void
  send(data: unknown, cb?: (err?: Error) => void): void
  ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void

  on(event: 'pong', listener: () => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): void
}

export interface IRequest {
  url?: string | undefined
}

export type WebsSocketData = string | Buffer | ArrayBuffer | Buffer[]

export type YjsServer = ReturnType<typeof createServer>

export type LoadDocFn = (name: string, doc: Y.Doc) => Promise<void>

export type StoreUpdateFn = (name: string, update: Uint8Array, doc: Y.Doc) => Promise<void>

export type StoreDocFn = (name: string, doc: Y.Doc) => Promise<void>

export interface DocStorage {
  loadDoc: LoadDocFn
  storeUpdate?: StoreUpdateFn
  storeDoc?: StoreDocFn
}

export enum MessageType {
  Sync = 0,
  Awareness = 1,
}

export enum CloseReason {
  CLOSE_NORMAL = 1000,
  CLOSE_UNSUPPORTED = 1003,
  INTERNAL_ERROR = 1011,
  PING_TIMEOUT = 4000,
}
