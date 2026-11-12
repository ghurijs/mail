// @ghuri/mail/smtp — SMTP backend (Django's smtp.EmailBackend) on node:net / node:tls. Node only (or a runtime with
// Node's net/tls); on Cloudflare Workers use cloudflareEmailBackend() or resendBackend() instead.

import { connect as netConnect, type Socket } from 'node:net'
import {
  type ConnectionOptions as TLSConnectionOptions,
  type TLSSocket,
  connect as tlsConnect,
} from 'node:tls'
import { ImproperlyConfigured, tryGetContext } from '@ghuri/core'
import { envelopeAddress } from './address'
import { BaseEmailBackend, type ConnectionOptions, type EmailBackendConfig } from './backends/base'
import { EmailSendError } from './errors'
import type { EmailMessage } from './message'

declare module '@ghuri/core' {
  interface GhuriSettings {
    /** SMTP host for `smtpBackend()` (default `'localhost'`). */
    EMAIL_HOST?: string
    /** SMTP port (default 25). */
    EMAIL_PORT?: number
    /** SMTP username (default `''`: no AUTH). */
    EMAIL_HOST_USER?: string
    /** SMTP password. */
    EMAIL_HOST_PASSWORD?: string
    /** Upgrade with STARTTLS (usually port 587). */
    EMAIL_USE_TLS?: boolean
    /** Implicit TLS (usually port 465). Mutually exclusive with `EMAIL_USE_TLS`. */
    EMAIL_USE_SSL?: boolean
  }
}

export interface SMTPBackendOptions {
  host?: string
  port?: number
  username?: string
  password?: string
  useTls?: boolean
  useSsl?: boolean
  /** Seconds before a blocking socket operation fails (default `EMAIL_TIMEOUT`, else none). */
  timeout?: number | null
  /** Extra `tls.connect()` options (CA, client certificate, `rejectUnauthorized`, ...). */
  tlsOptions?: TLSConnectionOptions
  /** Name sent with EHLO (default `'localhost'`). */
  localHostname?: string
}

interface Reply {
  code: number
  lines: string[]
}

function smtpError(reply: Reply, what: string): EmailSendError {
  return new EmailSendError(`SMTP ${what} failed: ${reply.code} ${reply.lines.join(' ')}`, {
    status: reply.code,
    response: reply,
  })
}

/** A minimal SMTP client (RFC 5321): EHLO/HELO, STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, RSET, QUIT. */
export class SMTPConnection {
  private socket!: Socket | TLSSocket
  private buffer = ''
  private decoder = new TextDecoder()
  private pending: string[] = []
  private replies: Reply[] = []
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = []
  private failure: Error | undefined
  extensions = new Map<string, string>()

  private constructor(
    private readonly host: string,
    private readonly timeout: number | null,
  ) {}

  static async connect(options: {
    host: string
    port: number
    useSsl: boolean
    timeout: number | null
    tlsOptions?: TLSConnectionOptions
  }): Promise<SMTPConnection> {
    const conn = new SMTPConnection(options.host, options.timeout)
    const socket = options.useSsl
      ? tlsConnect({
          host: options.host,
          port: options.port,
          servername: options.host,
          ...options.tlsOptions,
        })
      : netConnect({ host: options.host, port: options.port })
    conn.attach(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once(options.useSsl ? 'secureConnect' : 'connect', () => resolve())
      socket.once('error', reject)
    })
    const greeting = await conn.read()
    if (greeting.code !== 220) {
      conn.socket.destroy()
      throw smtpError(greeting, 'connect')
    }
    return conn
  }

  private attach(socket: Socket | TLSSocket): void {
    this.socket = socket
    this.decoder = new TextDecoder()
    if (this.timeout !== null) {
      socket.setTimeout(this.timeout * 1000, () => socket.destroy(new Error('SMTP connection timed out')))
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  private detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    this.socket.setTimeout(0)
  }

  private readonly onData = (chunk: Uint8Array) => {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    let i = this.buffer.indexOf('\n')
    while (i >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '')
      this.buffer = this.buffer.slice(i + 1)
      this.pending.push(line.slice(4))
      if (!/^\d{3}-/.test(line)) {
        const reply = { code: Number.parseInt(line.slice(0, 3), 10) || 0, lines: this.pending }
        this.pending = []
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(reply)
        else this.replies.push(reply)
      }
      i = this.buffer.indexOf('\n')
    }
  }

  private readonly onError = (err: Error) => this.fail(err)

  private readonly onClose = () => this.fail(new Error('SMTP server closed the connection'))

  private fail(err: Error): void {
    this.failure ??= err
    for (const w of this.waiters.splice(0)) w.reject(new EmailSendError(err.message, { cause: err }))
  }

  private read(): Promise<Reply> {
    const ready = this.replies.shift()
    if (ready) return Promise.resolve(ready)
    if (this.failure) return Promise.reject(new EmailSendError(this.failure.message, { cause: this.failure }))
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private write(data: string): void {
    this.socket.write(data)
  }

  /** Send a command and read its reply; raise when the code is not in `expect`. */
  async command(line: string, expect: number[], what = line.split(' ')[0]): Promise<Reply> {
    this.write(`${line}\r\n`)
    const reply = await this.read()
    if (!expect.includes(reply.code)) throw smtpError(reply, what)
    return reply
  }

  async ehlo(name: string): Promise<void> {
    this.write(`EHLO ${name}\r\n`)
    const reply = await this.read()
    this.extensions.clear()
    if (reply.code !== 250) {
      await this.command(`HELO ${name}`, [250])
      return
    }
    for (const line of reply.lines.slice(1)) {
      const [kw, ...rest] = line.split(/[\s=]/)
      this.extensions.set(kw.toUpperCase(), rest.join(' '))
    }
  }

  async starttls(tlsOptions?: TLSConnectionOptions): Promise<void> {
    if (!this.extensions.has('STARTTLS')) {
      throw new EmailSendError('STARTTLS extension not supported by server.')
    }
    await this.command('STARTTLS', [220])
    this.detach()
    const plain = this.socket as Socket
    const secure = tlsConnect({ socket: plain, servername: this.host, ...tlsOptions })
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve())
      secure.once('error', reject)
    })
    this.attach(secure)
  }

  async login(username: string, password: string): Promise<void> {
    const methods = (this.extensions.get('AUTH') ?? '').toUpperCase().split(/\s+/)
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
    if (methods.includes('PLAIN')) {
      await this.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, [235], 'AUTH')
    } else if (methods.includes('LOGIN')) {
      await this.command('AUTH LOGIN', [334], 'AUTH')
      await this.command(b64(username), [334], 'AUTH')
      await this.command(b64(password), [235], 'AUTH')
    } else {
      throw new EmailSendError('SMTP AUTH extension not supported by server.')
    }
  }

  /** Send one message; raises when the server refuses the sender, every recipient or the data. */
  async sendmail(from: string, recipients: string[], data: string): Promise<void> {
    await this.command(`MAIL FROM:<${from}>`, [250], 'MAIL FROM')
    let accepted = 0
    let lastRefusal: Reply | undefined
    for (const rcpt of recipients) {
      this.write(`RCPT TO:<${rcpt}>\r\n`)
      const reply = await this.read()
      if (reply.code === 250 || reply.code === 251) accepted++
      else lastRefusal = reply
    }
    if (!accepted) {
      await this.rset()
      throw smtpError(lastRefusal ?? { code: 0, lines: [] }, 'RCPT TO (all recipients refused)')
    }
    await this.command('DATA', [354])
    const body = data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
    this.write(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`)
    const reply = await this.read()
    if (reply.code !== 250) throw smtpError(reply, 'DATA')
  }

  async rset(): Promise<void> {
    try {
      await this.command('RSET', [250])
    } catch {
      // ignore: the connection may already be broken
    }
  }

  async quit(): Promise<void> {
    try {
      if (!this.failure) await this.command('QUIT', [221])
    } catch {
      // ignore
    } finally {
      this.detach()
      this.socket.destroy()
    }
  }

  close(): void {
    this.detach()
    this.socket.destroy()
  }
}

type ResolvedSMTPOptions = Required<Omit<SMTPBackendOptions, 'tlsOptions' | 'timeout'>> & {
  timeout: number | null
  tlsOptions?: TLSConnectionOptions
}

/** Django's SMTP `EmailBackend`: one connection per `sendMessages()` call unless opened with `open()`. */
export class SMTPBackend extends BaseEmailBackend {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly useTls: boolean
  readonly useSsl: boolean
  readonly timeout: number | null
  readonly tlsOptions?: TLSConnectionOptions
  readonly localHostname: string
  connection: SMTPConnection | null = null

  constructor(options: ConnectionOptions & ResolvedSMTPOptions) {
    super(options)
    this.host = options.host
    this.port = options.port
    this.username = options.username
    this.password = options.password
    this.useTls = options.useTls
    this.useSsl = options.useSsl
    this.timeout = options.timeout
    this.tlsOptions = options.tlsOptions
    this.localHostname = options.localHostname
    if (this.useTls && this.useSsl) {
      throw new ImproperlyConfigured(
        'EMAIL_USE_TLS/EMAIL_USE_SSL are mutually exclusive, so only set one of those settings to True.',
      )
    }
  }

  override async open(): Promise<boolean> {
    if (this.connection) return false
    try {
      const conn = await SMTPConnection.connect({
        host: this.host,
        port: this.port,
        useSsl: this.useSsl,
        timeout: this.timeout,
        tlsOptions: this.tlsOptions,
      })
      try {
        await conn.ehlo(this.localHostname)
        if (this.useTls) {
          await conn.starttls(this.tlsOptions)
          await conn.ehlo(this.localHostname)
        }
        if (this.username && this.password) await conn.login(this.username, this.password)
      } catch (err) {
        conn.close()
        throw err
      }
      this.connection = conn
      return true
    } catch (err) {
      if (!this.failSilently) {
        throw err instanceof EmailSendError
          ? err
          : new EmailSendError(`SMTP connection failed: ${(err as Error)?.message ?? err}`, { cause: err })
      }
      return false
    }
  }

  override async close(): Promise<void> {
    const conn = this.connection
    this.connection = null
    if (conn) await conn.quit()
  }

  async sendMessages(messages: EmailMessage[]): Promise<number> {
    if (!messages.length) return 0
    const opened = await this.open()
    const conn = this.connection
    if (!conn) return 0
    try {
      return await this.sendEach(messages, async (message) => {
        const data = message.message().asString()
        const from = envelopeAddress(message.fromEmail)
        const recipients = message.recipients().map(envelopeAddress)
        try {
          await conn.sendmail(from, recipients, data)
        } catch (err) {
          await conn.rset()
          throw err
        }
      })
    } finally {
      if (opened) await this.close()
    }
  }
}

/**
 * `EMAIL_BACKEND: smtpBackend({ host, port, username, password, useTls })`. Options fall back to Django's settings
 * (`EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_USE_TLS`, `EMAIL_USE_SSL`,
 * `EMAIL_TIMEOUT`); `getConnection(smtpBackend(), { username, password })` overrides per connection.
 */
export function smtpBackend(options: SMTPBackendOptions = {}): EmailBackendConfig {
  return {
    backend: 'smtp',
    create(_env, connection) {
      const s = tryGetContext()?.settings
      const pick = <T>(key: keyof SMTPBackendOptions, setting: unknown, fallback: T): T => {
        const v = connection[key] ?? options[key] ?? setting
        return (v === undefined || v === null ? fallback : v) as T
      }
      return new SMTPBackend({
        failSilently: connection.failSilently,
        host: pick('host', s?.EMAIL_HOST, 'localhost'),
        port: pick('port', s?.EMAIL_PORT, 25),
        username: pick('username', s?.EMAIL_HOST_USER, ''),
        password: pick('password', s?.EMAIL_HOST_PASSWORD, ''),
        useTls: pick('useTls', s?.EMAIL_USE_TLS, false),
        useSsl: pick('useSsl', s?.EMAIL_USE_SSL, false),
        timeout: pick<number | null>('timeout', s?.EMAIL_TIMEOUT, null),
        tlsOptions: (connection.tlsOptions as TLSConnectionOptions | undefined) ?? options.tlsOptions,
        localHostname: pick('localHostname', undefined, 'localhost'),
      })
    },
  }
}
