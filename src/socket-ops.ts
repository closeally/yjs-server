import type { IWebSocket, Logger } from './types.js'
import { CloseReason } from './types.js'
import invariant from 'tiny-invariant'
import { CONNECTING, OPEN } from './internal.js'

export const send = (conn: IWebSocket, m: Uint8Array): void => {
  try {
    invariant(conn.readyState === OPEN || conn.readyState === CONNECTING, 'conn is not open')

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
        conn.terminate()
      }
    } catch (err) {
      logger.error({ err }, 'error during keep alive')
      conn.terminate()
      clearInterval(pingInterval)
    }
  }, pingTimeout)

  conn.on('pong', () => {
    isAlive = true
  })

  conn.addEventListener('close', () => {
    clearInterval(pingInterval)
  })
}
