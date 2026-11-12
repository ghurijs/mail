import type { EmailMessage } from '../message'
import { BaseEmailBackend, type ConnectionOptions, type EmailBackendConfig } from './base'

/** Where the console backend writes (`process.stdout` works; the default is `console.log`). */
export interface WritableLike {
  write(text: string): unknown
}

export interface ConsoleBackendOptions {
  stream?: WritableLike
}

const defaultStream: WritableLike = {
  write(text) {
    console.log(text.replace(/\n$/, ''))
  },
}

/** Writes each message (full MIME source) to a stream instead of sending it (Django's console backend). */
export class ConsoleBackend extends BaseEmailBackend {
  stream: WritableLike

  constructor(options: ConnectionOptions & ConsoleBackendOptions = {}) {
    super(options)
    this.stream = options.stream ?? defaultStream
  }

  async sendMessages(messages: EmailMessage[]): Promise<number> {
    return this.sendEach(
      messages,
      async (message) => {
        const source = message.message().asString().replace(/\r\n/g, '\n')
        this.stream.write(`${source}\n${'-'.repeat(79)}\n`)
      },
      { skipEmpty: false },
    )
  }
}

/** `EMAIL_BACKEND: consoleBackend()` prints messages instead of sending them (the default in `DEBUG`). */
export function consoleBackend(options: ConsoleBackendOptions = {}): EmailBackendConfig {
  return {
    backend: 'console',
    create: (_env, connection) => new ConsoleBackend({ ...options, ...connection }),
  }
}
