export class YjsServerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YjsServerError'
  }
}
