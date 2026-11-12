import { type AddressInfo, createServer, type Server, type Socket } from 'node:net'
import { ImproperlyConfigured } from '@ghuri/core'
import { afterEach, describe, expect, it } from 'vitest'
import { EmailMessage, EmailSendError, getConnection, sendMail, sendMassMail } from '../src/index'
import { SMTPBackend, smtpBackend } from '../src/smtp'
import { withSettings } from './helpers'

interface Session {
  commands: string[]
  messages: Array<{ from: string; to: string[]; data: string }>
  auth: string[]
}

interface FakeOptions {
  auth?: string
  refuse?: string[]
  ehlo?: boolean
}

/** A tiny SMTP server that records what it receives. */
async function fakeSmtp(
  opts: FakeOptions = {},
): Promise<{ server: Server; port: number; sessions: Session[] }> {
  const sessions: Session[] = []
  const server = createServer((socket: Socket) => {
    const session: Session = { commands: [], messages: [], auth: [] }
    sessions.push(session)
    let buffer = ''
    let inData = false
    let data: string[] = []
    let from = ''
    let to: string[] = []
    let loginStep = 0
    const reply = (s: string) => socket.write(`${s}\r\n`)
    reply('220 fake.test ESMTP')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let i = buffer.indexOf('\r\n')
      while (i >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        i = buffer.indexOf('\r\n')
        if (inData) {
          if (line === '.') {
            inData = false
            session.messages.push({ from, to, data: data.join('\r\n') })
            data = []
            reply('250 2.0.0 queued')
          } else {
            data.push(line)
          }
          continue
        }
        if (loginStep === 1) {
          session.auth.push(Buffer.from(line, 'base64').toString())
          loginStep = 2
          reply('334 UGFzc3dvcmQ6')
          continue
        }
        if (loginStep === 2) {
          session.auth.push(Buffer.from(line, 'base64').toString())
          loginStep = 0
          reply('235 2.7.0 Authentication successful')
          continue
        }
        session.commands.push(line)
        const verb = line.split(' ')[0].toUpperCase()
        if (verb === 'EHLO') {
          if (opts.ehlo === false) reply('502 not implemented')
          else
            reply(`250-fake.test\r\n250-PIPELINING\r\n250-AUTH ${opts.auth ?? 'PLAIN LOGIN'}\r\n250 8BITMIME`)
        } else if (verb === 'HELO') reply('250 fake.test')
        else if (verb === 'AUTH') {
          const [, method, arg] = line.split(' ')
          if (method === 'PLAIN') {
            session.auth.push(Buffer.from(arg, 'base64').toString())
            reply('235 2.7.0 Authentication successful')
          } else {
            loginStep = 1
            reply('334 VXNlcm5hbWU6')
          }
        } else if (verb === 'MAIL') {
          from = /<(.*)>/.exec(line)![1]
          to = []
          reply('250 OK')
        } else if (verb === 'RCPT') {
          const rcpt = /<(.*)>/.exec(line)![1]
          if (opts.refuse?.includes(rcpt)) reply('550 5.1.1 No such user')
          else {
            to.push(rcpt)
            reply('250 OK')
          }
        } else if (verb === 'DATA') {
          inData = true
          reply('354 End data with <CR><LF>.<CR><LF>')
        } else if (verb === 'RSET') reply('250 OK')
        else if (verb === 'QUIT') {
          reply('221 Bye')
          socket.end()
        } else reply('500 unknown')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { server, port: (server.address() as AddressInfo).port, sessions }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe('smtpBackend (@ghuri/mail/smtp)', () => {
  it('sends over one connection per sendMessages() with AUTH PLAIN', async () => {
    const { port, sessions } = await fakeSmtp()
    const conn = getConnection(
      smtpBackend({ host: '127.0.0.1', port, username: 'user', password: 'secret', timeout: 5 }),
    )
    expect(conn).toBeInstanceOf(SMTPBackend)
    const n = await conn.sendMessages([
      new EmailMessage('One', 'first\n.leading dot', {
        fromEmail: 'Shop <shop@example.com>',
        to: ['a@example.com'],
        bcc: ['hidden@example.com'],
      }),
      new EmailMessage('Two', 'second', { fromEmail: 'shop@example.com', to: ['b@exämple.com'] }),
      new EmailMessage('Nobody', 'skipped'),
    ])
    expect(n).toBe(2)
    expect(sessions).toHaveLength(1)
    const [s] = sessions
    expect(s.auth).toEqual(['\0user\0secret'])
    expect(s.commands[0]).toBe('EHLO localhost')
    expect(s.commands.at(-1)).toBe('QUIT')
    expect(s.messages[0].from).toBe('shop@example.com')
    expect(s.messages[0].to).toEqual(['a@example.com', 'hidden@example.com'])
    expect(s.messages[0].data).toContain('Subject: One')
    expect(s.messages[0].data).not.toContain('hidden@example.com')
    expect(s.messages[0].data).toContain('\r\n..leading dot')
    expect(s.messages[1].to).toEqual(['b@xn--exmple-cua.com'])
  })

  it('falls back to AUTH LOGIN and to HELO', async () => {
    const login = await fakeSmtp({ auth: 'LOGIN' })
    await getConnection(smtpBackend({ host: '127.0.0.1', port: login.port }), {
      username: 'u',
      password: 'p',
    }).sendMessages([new EmailMessage('s', 'b', { to: ['a@example.com'] })])
    expect(login.sessions[0].auth).toEqual(['u', 'p'])

    const helo = await fakeSmtp({ ehlo: false })
    const n = await getConnection(smtpBackend({ host: '127.0.0.1', port: helo.port })).sendMessages([
      new EmailMessage('s', 'b', { to: ['a@example.com'] }),
    ])
    expect(n).toBe(1)
    expect(helo.sessions[0].commands.slice(0, 2)).toEqual(['EHLO localhost', 'HELO localhost'])
  })

  it('reads Django settings (EMAIL_HOST, EMAIL_PORT, EMAIL_HOST_USER, ...) and sendMail auth options', async () => {
    const { port, sessions } = await fakeSmtp()
    const settings = {
      EMAIL_BACKEND: smtpBackend(),
      EMAIL_HOST: '127.0.0.1',
      EMAIL_PORT: port,
      EMAIL_HOST_USER: 'settings-user',
      EMAIL_HOST_PASSWORD: 'pw',
    }
    await withSettings(settings, () => sendMail('s', 'b', 'f@example.com', ['t@example.com']))
    await withSettings(settings, () =>
      sendMail('s', 'b', 'f@example.com', ['t@example.com'], { authUser: 'other', authPassword: 'x' }),
    )
    expect(sessions.map((s) => s.auth[0])).toEqual(['\0settings-user\0pw', '\0other\0x'])
  })

  it('keeps the connection open between open() and close()', async () => {
    const { port, sessions } = await fakeSmtp()
    const conn = getConnection(smtpBackend({ host: '127.0.0.1', port }))
    expect(await conn.open()).toBe(true)
    expect(await conn.open()).toBe(false)
    await conn.sendMessages([new EmailMessage('1', 'b', { to: ['a@example.com'] })])
    await conn.sendMessages([new EmailMessage('2', 'b', { to: ['a@example.com'] })])
    await conn.close()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].messages).toHaveLength(2)
    expect(sessions[0].commands.at(-1)).toBe('QUIT')
  })

  it('sendMassMail uses one SMTP session', async () => {
    const { port, sessions } = await fakeSmtp()
    const n = await withSettings({ EMAIL_BACKEND: smtpBackend({ host: '127.0.0.1', port }) }, () =>
      sendMassMail([
        ['a', 'b', null, ['x@example.com']],
        ['c', 'd', null, ['y@example.com']],
      ]),
    )
    expect(n).toBe(2)
    expect(sessions).toHaveLength(1)
  })

  it('delivers to accepted recipients and fails when all are refused', async () => {
    const { port, sessions } = await fakeSmtp({ refuse: ['bad@example.com'] })
    const conn = getConnection(smtpBackend({ host: '127.0.0.1', port }))
    expect(
      await conn.sendMessages([new EmailMessage('s', 'b', { to: ['ok@example.com', 'bad@example.com'] })]),
    ).toBe(1)
    expect(sessions[0].messages[0].to).toEqual(['ok@example.com'])

    const err = await conn
      .sendMessages([new EmailMessage('s', 'b', { to: ['bad@example.com'] })])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EmailSendError)
    expect(err).toMatchObject({ status: 550 })
    expect(sessions[1].commands).toContain('RSET')

    const silent = getConnection(smtpBackend({ host: '127.0.0.1', port }), { failSilently: true })
    expect(
      await silent.sendMessages([
        new EmailMessage('s', 'b', { to: ['bad@example.com'] }),
        new EmailMessage('s', 'b', { to: ['ok@example.com'] }),
      ]),
    ).toBe(1)
  })

  it('reports connection errors unless failSilently', async () => {
    const { server, port } = await fakeSmtp()
    await new Promise((r) => server.close(r))
    const m = new EmailMessage('s', 'b', { to: ['a@example.com'] })
    await expect(
      getConnection(smtpBackend({ host: '127.0.0.1', port })).sendMessages([m]),
    ).rejects.toBeInstanceOf(EmailSendError)
    expect(
      await getConnection(smtpBackend({ host: '127.0.0.1', port }), { failSilently: true }).sendMessages([m]),
    ).toBe(0)
  })

  it('needs STARTTLS support for useTls and an AUTH method for credentials', async () => {
    const { port } = await fakeSmtp({ auth: 'CRAM-MD5' })
    const m = new EmailMessage('s', 'b', { to: ['a@example.com'] })
    await expect(
      getConnection(smtpBackend({ host: '127.0.0.1', port, useTls: true })).sendMessages([m]),
    ).rejects.toThrow('STARTTLS extension not supported by server.')
    await expect(
      getConnection(smtpBackend({ host: '127.0.0.1', port, username: 'u', password: 'p' })).sendMessages([m]),
    ).rejects.toThrow('SMTP AUTH extension not supported by server.')
  })

  it('rejects useTls together with useSsl', () => {
    expect(() => getConnection(smtpBackend({ useTls: true, useSsl: true }))).toThrow(ImproperlyConfigured)
  })
})
