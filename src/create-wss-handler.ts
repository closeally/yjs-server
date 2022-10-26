import type { IWebSocket, WebSocketServer, YjsServer } from './types.js'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'

interface CreateHandlerOptions<WS extends IWebSocket> {
  wss: WebSocketServer<WS>
  handleConnection: YjsServer['handleConnection']
}

export const createWssHandler = <WS extends IWebSocket>({
  wss,
  handleConnection,
}: CreateHandlerOptions<WS>) => {
  wss.on('connection', handleConnection)

  return {
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      upgradeHead: Buffer,
      callback?: (client: WS, request: IncomingMessage) => void,
    ) {
      wss.handleUpgrade(request, socket, upgradeHead, (ws) => {
        wss.emit('connection', ws, request)
        callback?.(ws, request)
      })
    },
  }
}
