# Yjs Server

An extensible, [y-websocket](https://github.com/yjs/y-websocket)-compatible server. Written in
TypeScript. Supports authentication. ESM-only.

## Quickstart

Install it:

```
npm i yjs-server
```

A public server:

```typescript
// server.js
import { WebSocketServer } from 'ws'
import { createYjsServer } from 'yjs-server'

const wss = new WebSocketServer({ port: 8080 })
const yjss = createYjsServer({
  createDoc: () => new Y.Doc(),
})

wss.on('connection', (socket, request) => {
  yjss.handleConnection(socket, request)
})
```

Run it with `node server.js`.

A server with authentication:

```typescript
// server.ts
import { WebSocketServer, WebSocket } from 'ws'
import { createYjsServer, defaultDocNameFromRequest } from 'yjs-server'

const wss = new WebSocketServer({ port: 8080 })
const yjss = createYjsServer({
  createDoc: () => new Y.Doc(),
})

wss.on('connection', (socket, request) => {
  const whenAuthorized = authorize(socket, request).catch(() => {
    // manually close the socket using a custom error code
    conn.close(4001)

    // signal that the YjsServer should drop the connection
    return false
  })

  // handleConnection must be called immediately after the connection is established
  // otherwise, messages might be lost
  yjss.handleConnection(socket, request, whenAuthorized)
})

async function authorize(socket: WebSocket, request: http.IncomingMessage) {
  // option 1) use a param in the request.url
  const docName = defaultDocNameFromRequest(req)

  if (!docName) throw new Error('invalid doc name')

  const auth = new URL(req.url!, 'http://localhost').searchParams.get('authQueryParam')

  // validate auth has access to docName...

  // option2) use request.headers.cookie (only works if the server is on the same origin)

  // signal that the connection should be considered authorized
  return true
}
```

On the client:

```javascript
// client.js
import { WebsocketProvider } from 'y-websocket'

const wsProvider = new WebsocketProvider('ws://localhost:8080', 'roomName', yjsDoc, {
  params: { authQueryParam: 'authToken...' },
})

wsProvider.on('connection-close', (event: CloseEvent) => {
  // use the same custom code sent in the server
  if (event.code === 4001) {
    logger.error({ event }, 'received unauthorized error from server')

    // signal the WebsocketProvider to stop reconnecting
    wsProvider.shouldConnect = false
  }
})
```

The server will buffer all messages until the `whenAuthorized` promise resolves. Only if the promise
resolves with `true`, the connection will be considered authenticated. See
the [should-connect.test.ts](test/should-connect.test.ts) for more supported scenarios.

## Motivation

Yjs is a great library, but the server included in y-websocket is limited in its capabilities: it is
difficult to extend from the outside, tests are missing, authentication is not easy to implement,
the server can't be imported as a module in an existing server, and there are not many security
checks in place (try sending a string message instead of a bytearray in an open websocket client,
the server will infinitely loop)

This library aims to solve these problems.

## Usage Examples

### With an external HTTP server

```javascript
const httpServer = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end()
})

const wss = new WebSocketServer({ noServer: true })

const yjsServer = createYjsServer({
  createDoc: () => new Y.Doc(),
})

wss.on('connection', yjsServer.handleConnection)

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

const port = process.env['PORT'] ?? 8080
httpServer.listen(port, () => {
  console.info(`listening on port ${port}`)
})
```

### With persistent storage

```javascript
const client = new SomeExternalDbClient()

const wss = new WebSocketServer({ port: 8080 })
const yjss = createYjsServer({
  createDoc: () => new Y.Doc(),
  docStorage: {
    loadDoc: async (docName, doc) => {
      const persistedDocBytes = await client.getDoc(docName)
      if (persistedDocBytes) Y.applyUpdate(doc, persistedDocBytes)
    },
    storeDoc: async (docName, doc) => {
      await client.setDoc(docName, Y.encodeStateAsUpdate(doc))
    },
  },
})

wss.on('connection', (socket, request) => {
  yjss.handleConnection(socket, request)
})
```

## API

### createYjsServer(options: CreateYjsServerOptions) => YjsServer

The server acts as a container for document state and handles multiple WebSocket connections per
document. It does not bind to any port or expose any functionality over HTTP. You must use an
external WebSocket server such as [ws](https://github.com/websockets/ws) to handle the WebSocket
connections.

You can create many servers in the same process.

```typescript
type CreateYjsServerOptions = {
  /**
   * Factory function for creating new Y.Doc instances. You can customize
   * the Y.Doc parameters here
   */
  createDoc: () => Y.Doc

  /**
   * A console-like object for logging errors and warnings. Defaults to
   * `console`
   */
  logger?: Logger

  /**
   * A function that returns the document name from the request. Defaults
   * to the first path segment of the url
   */
  docNameFromRequest?: (request: IRequest) => string | undefined

  /**
   * Support for loading and saving documents from a database, see
   * DocStorage section below. Defaults to no persistence
   */
  docStorage?: DocStorage

  /**
   * Set the ping/pong interval to detect dead connections. Defaults to
   * 30 seconds
   */
  pingTimeoutMs?: number

  /**
   * Set the maximum amount of bytes that can be buffered per authenticated
   * connection while waiting for the room to load, only applicable if using
   * `docStorage`, defaults to 100MB
   */
  maxBufferedBytes?: number

  /**
   * Set the maximum amount of bytes that can be buffered per unauthenticated
   * connection while waiting for the `shouldConnect` promise to resolve,
   * defaults to 5MB
   */
  maxBufferedBytesBeforeConnect?: number
}
```

```typescript
type YjsServer = {
  /**
   * Handle a new WebSocket connection, this must be called immediately after
   * the connection is established; otherwise, messages might be lost.
   *
   * @param conn
   * @param req
   * @param shouldConnect A promise that resolves to a boolean indicating if
   * the connection should be considered authenticated. If the promise resolves
   * with `false`, the connection will be silently dropped but not closed. If
   * the promise rejects, the connection will be terminated.
   *
   * Messages will be buffered until the promise resolves. This is necessary
   * because the y-websocket client sends messages immediately after the
   * connection is established.
   *
   * It can be used for more than just authentication as longs as the promise
   * resolves to a boolean.
   *
   * If the argument is omitted, the connection will be considered authenticated.
   */
  handleConnection(conn: IWebSocket, req: IRequest, shouldConnect?: Promise<boolean>): void

  /**
   * Close all open connections; after this method is called, the server
   * should not be used anymore.
   *
   * The YjsServer won't wait for the connections to close; it will just call the
   * `close` method on each connection. If you are using `ws`, you can set the
   * clientTracking option to `true` on the WebSocketServer constructor to get
   * the websocket server to wait for the connections to close.
   *
   * @param code The close code to send to all clients
   * @param terminateTimeout If set to a number, the number of milliseconds to
   * wait for all connections to close before forcefully terminating them.
   */
  close(code?: number, terminateTimeout?: number | null): void
}
```

### DocStorage

The `docStorage` option allows you to load and save documents from a database.

There are generally two ways to implement this interface:

1. Load the document from the database when the first connection is established, and save the
   document when the last connection is closed. This is the most straightforward approach, but it
   has the downside that the document will be lost if the server crashes before the last connection
   is closed. In practice, if clients use [y-indexeddb](https://github.com/yjs/y-indexeddb), the
   downside is mitigated because the document is stored locally in the browser. The document will
   sync to the server when the connection is re-established.
2. Load the document from the database when the first connection is established, and save the
   document every time a change is made. This is more complex, but it has the advantage that the
   document will not be lost if the server crashes.

For option 1, you can implement the `loadDoc` and `saveDoc` functions. For option 2, you can
implement the `loadDoc` and `onUpdate` functions.

```typescript
type DocStorage = {
  loadDoc: LoadDocFn
  storeDoc?: StoreDocFn
  onUpdate?: OnUpdateFn
}

/**
 * Load a document from some storage, this function is called when the first
 * connection to a document is established.
 *
 * If the function throws an error, all connections waiting for the document
 * to load will be closed.
 *
 * You should apply any updates to the given document using the approach
 * described here: https://docs.yjs.dev/api/document-updates#syncing-clients
 *
 * For example, uf using [y-leveldb](https://github.com/yjs/y-leveldb):
 *
 * const loadDoc = async (name: string, ydoc: Y.Doc) => {
 *   const persistedYdoc = await ldb.getYDoc(docName)
 *   const newUpdates = Y.encodeStateAsUpdate(ydoc)
 *   ldb.storeUpdate(docName, newUpdates)
 *   Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc))
 * }
 */
type LoadDocFn = (name: string, doc: Y.Doc) => Promise<void>

/**
 * Save a document to some storage, this function is called when the last
 * connection to a document is closed. After this function resolves, the Y.Doc
 * instance will be destroyed.
 */
type StoreDocFn = (name: string, doc: Y.Doc) => Promise<void>

/**
 * This function is called every time a change is made to a document. It can be
 * used for more than just saving the document, for example, you can use it to
 * run a "fixer" process that automatically checks for document inconsistencies.
 */
type OnUpdateFn = (name: string, update: Uint8Array, doc: Y.Doc) => Promise<void>
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Future plans

1. **Support horizontal scaling**. Right now, the server is not horizontally scalable. It is
   possible to run multiple server instances (even on the same node instance), but they will not
   share the same state. I recommend deploying many instances of the server for different document
   types. In the future, we could support horizontal scaling using Redis or direct server-to-server
   communication with the Yjs protocol.
2. **Multi-document support per connection**. This is probably needed to support server-to-server
   communications.

## License

MIT

Some code was directly copied from [y-websocket](https://github.com/yjs/y-websocket).
