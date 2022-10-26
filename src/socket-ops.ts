import type { IWebSocket, Logger } from './types.js'
import { CloseReason } from './types.js'

const CONNECTING = 0
const OPEN = 1

export const send = (conn: IWebSocket, m: Uint8Array): void => {
  if (conn.readyState !== CONNECTING && conn.readyState !== OPEN) {
    conn.close(CloseReason.INTERNAL_ERROR)
  }

  try {
    conn.send(m, (err) => {
      if (err) conn.close(CloseReason.INTERNAL_ERROR)
    })
  } catch (e) {
    conn.close(CloseReason.INTERNAL_ERROR)
  }
}

export const keepAlive = (conn: IWebSocket, pingTimeout: number, logger: Logger) => {
  let isAlive = true

  const pingInterval = setInterval(() => {
    try {
      if (isAlive) {
        isAlive = false
        conn.ping()
      } else {
        clearInterval(pingInterval)
        conn.close(CloseReason.PING_TIMEOUT)
      }
    } catch (err) {
      logger.error({ err }, 'error during keep alive')
      conn.close(CloseReason.PING_TIMEOUT)
    } finally {
      clearInterval(pingInterval)
    }
  }, pingTimeout)

  conn.on('pong', () => {
    isAlive = true
  })

  conn.on('close', () => {
    clearInterval(pingInterval)
  })
}
