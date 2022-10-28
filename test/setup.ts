import { afterAll } from 'vitest'
import { startedServers } from './fixtures.js'

// @ts-expect-error don't allow any funny business from y-websocket
global.BroadcastChannel = undefined

afterAll(() => {
  startedServers.forEach((wss) => wss.close())
})
