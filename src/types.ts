import type * as Y from 'yjs'

export type LogFn = <T extends object>(obj: T, msg: string, ...args: unknown[]) => void

export interface Logger {
  info: LogFn
  error: LogFn
  warn: LogFn
}

export interface MessageEvent {
  data: WebsSocketData
}

export interface CloseEvent {
  code: number
}

export interface IWebSocket {
  binaryType: 'arraybuffer' | string

  readonly readyState: number
  send(data: unknown, cb?: (err?: Error) => void): void
  ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void
  close(code?: number, data?: string | Buffer): void
  terminate(): void

  on(event: 'pong', listener: () => void): void

  addEventListener(event: 'close', listener: (event: CloseEvent) => void): void
  addEventListener(event: 'message', listener: (event: MessageEvent) => void): void

  removeEventListener(method: 'message', cb: (event: MessageEvent) => void): void
  removeEventListener(method: 'close', cb: (event: CloseEvent) => void): void
}

export interface IRequest {
  url?: string | undefined
}

export type WebsSocketData = string | Buffer | ArrayBuffer | Buffer[]

export interface YjsServer {
  handleConnection(conn: IWebSocket, req: IRequest, shouldConnect?: Promise<boolean>): void
  close(code?: number, terminateTimeout?: number | null): void
}

export type LoadDocFn = (name: string, doc: Y.Doc) => Promise<void>

export type OnUpdateFn = (name: string, update: Uint8Array, doc: Y.Doc) => Promise<void>

export type StoreDocFn = (name: string, doc: Y.Doc) => Promise<void>

export interface DocStorage {
  loadDoc: LoadDocFn
  onUpdate?: OnUpdateFn
  storeDoc?: StoreDocFn
}

export enum CloseReason {
  NORMAL = 1000,
  UNSUPPORTED = 1003,
  INTERNAL_ERROR = 1011,
}
