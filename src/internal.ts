export enum MessageType {
  Sync = 0,
  Awareness = 1,
}

export const CONNECTING = 0
export const OPEN = 1
export const CLOSING = 2
export const CLOSED = 3

export const invariant = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message)
  }
}
