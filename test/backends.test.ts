import { ImproperlyConfigured } from '@ghuri/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BadHeaderError,
  CloudflareEmailBackend,
  type CloudflareEmailBuilder,
  ConsoleBackend,
  cloudflareEmailBackend,
  consoleBackend,
  DummyBackend,
  dummyBackend,
  EmailMessage,
  EmailMultiAlternatives,
  EmailSendError,
  getConnection,
  LocmemBackend,
  locmemBackend,
  ResendBackend,
  resendBackend,
  sendMail,
} from '../src/index'
import { clearOutbox, outbox } from '../src/testing'
import { withSettings } from './helpers'

beforeEach(() => clearOutbox())

function richMessage(): EmailMultiAlternatives {
  const m = new EmailMultiAlternatives('Order #1', 'Thanks for your order.', {
    fromEmail: 'Shop <shop@example.com>',
    to: ['Jane <jane@example.com>'],
    cc: ['cc@example.com'],
    bcc: ['bcc@example.com'],
    replyTo: ['support@example.com'],
    headers: { 'X-Order': '1', 'List-Unsubscribe': '<mailto:unsub@example.com>', To: 'ignored@example.com' },
  })
  m.attachAlternative('<p>Thanks for your order.</p>', 'text/html')
  m.attach('invoice.pdf', new Uint8Array([37, 80, 68, 70]))
  m.attach('notes.txt', 'héllo')
  return m
}

describe('consoleBackend', () => {
  it('writes each message with a separator and returns the count', async () => {
    const chunks: string[] = []
    const conn = getConnection(consoleBackend({ stream: { write: (t) => chunks.push(t) } }))
    expect(conn).toBeInstanceOf(ConsoleBackend)
    const n = await conn.sendMessages([
      new EmailMessage('First', 'one', { to: ['a@example.com'] }),
      new EmailMessage('Second', 'two'),
    ])
    expect(n).toBe(2)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toContain('Subject: First\n')
    expect(chunks[0]).toContain('To: a@example.com\n')
    expect(chunks[0].endsWith(`\n${'-'.repeat(79)}\n`)).toBe(true)
    expect(chunks[0]).not.toContain('\r')
  })

  it('logs with console.log by default', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await getConnection(consoleBackend()).sendMessages([
        new EmailMessage('Hi', 'b', { to: ['a@example.com'] }),
      ])
      expect(spy).toHaveBeenCalledOnce()
      expect(spy.mock.calls[0][0]).toContain('Subject: Hi')
    } finally {
      spy.mockRestore()
    }
  })

  it('raises BadHeaderError unless failSilently', async () => {
    const bad = new EmailMessage('a\nb', 'b', { to: ['a@example.com'] })
    const stream = { write: () => {} }
    await expect(getConnection(consoleBackend({ stream })).sendMessages([bad])).rejects.toBeInstanceOf(
      BadHeaderError,
    )
    expect(await getConnection(consoleBackend({ stream }), { failSilently: true }).sendMessages([bad])).toBe(
      0,
    )
  })
})

describe('locmemBackend', () => {
  it('appends to the outbox', async () => {
    const conn = getConnection(locmemBackend())
    expect(conn).toBeInstanceOf(LocmemBackend)
    const m = new EmailMessage('s', 'b', { to: ['a@example.com'] })
    expect(await conn.sendMessages([m, new EmailMessage('t', 'c')])).toBe(2)
    expect(outbox[0]).toBe(m)
    expect(outbox).toHaveLength(2)
  })

  it('validates headers before storing', async () => {
    await expect(
      getConnection(locmemBackend()).sendMessages([new EmailMessage('a\nb', 'b', { to: ['a@example.com'] })]),
    ).rejects.toBeInstanceOf(BadHeaderError)
    expect(outbox).toHaveLength(0)
  })
})

describe('dummyBackend', () => {
  it('discards messages and reports them sent', async () => {
    const conn = getConnection(dummyBackend())
    expect(conn).toBeInstanceOf(DummyBackend)
    expect(await conn.sendMessages([new EmailMessage('s', 'b'), new EmailMessage('s', 'b')])).toBe(2)
    expect(outbox).toHaveLength(0)
    expect(
      await withSettings({ EMAIL_BACKEND: dummyBackend() }, () => sendMail('s', 'b', null, ['a@x.com'])),
    ).toBe(1)
  })
})

describe('resendBackend', () => {
  function mockFetch(response: () => Response) {
    const calls: Array<{ url: string; init: RequestInit; body: any }> = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) })
      return response()
    }) as unknown as typeof globalThis.fetch
    return { fetch, calls }
  }
  const ok = () => new Response(JSON.stringify({ id: '49a3999c' }), { status: 200 })

  it('POSTs the documented JSON shape to /emails', async () => {
    const { fetch, calls } = mockFetch(ok)
    const conn = getConnection(resendBackend({ apiKey: 're_test', fetch }))
    expect(conn).toBeInstanceOf(ResendBackend)
    expect(await conn.sendMessages([richMessage()])).toBe(1)
    expect(calls).toHaveLength(1)
    const [{ url, init, body }] = calls
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Bearer re_test', 'Content-Type': 'application/json' })
    expect(init.signal).toBeUndefined()
    expect(body).toEqual({
      from: 'Shop <shop@example.com>',
      to: ['Jane <jane@example.com>'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      reply_to: ['support@example.com'],
      subject: 'Order #1',
      text: 'Thanks for your order.',
      html: '<p>Thanks for your order.</p>',
      headers: { 'X-Order': '1', 'List-Unsubscribe': '<mailto:unsub@example.com>' },
      attachments: [
        { filename: 'invoice.pdf', content: btoa('%PDF'), content_type: 'application/pdf' },
        {
          filename: 'notes.txt',
          content: btoa(String.fromCharCode(...new TextEncoder().encode('héllo'))),
          content_type: 'text/plain',
        },
      ],
    })
  })

  it('sends an HTML-only body as html and omits empty fields', async () => {
    const { fetch, calls } = mockFetch(ok)
    const m = new EmailMessage('s', '<b>hi</b>', { fromEmail: 'a@example.com', to: ['b@example.com'] })
    m.contentSubtype = 'html'
    await getConnection(resendBackend({ apiKey: 'k', fetch })).sendMessages([m])
    expect(calls[0].body).toEqual({
      from: 'a@example.com',
      to: ['b@example.com'],
      subject: 's',
      html: '<b>hi</b>',
    })
  })

  it('uses EMAIL_TIMEOUT, baseUrl and a per-connection apiKey', async () => {
    const { fetch, calls } = mockFetch(ok)
    await withSettings({ EMAIL_TIMEOUT: 5 }, () =>
      getConnection(resendBackend({ apiKey: 'k', fetch, baseUrl: 'https://proxy.test/' }), {
        apiKey: 'other',
      }).sendMessages([new EmailMessage('s', 'b', { to: ['a@example.com'] })]),
    )
    expect(calls[0].url).toBe('https://proxy.test/emails')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer other')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends one request per message and skips messages without recipients', async () => {
    const { fetch, calls } = mockFetch(ok)
    const n = await getConnection(resendBackend({ apiKey: 'k', fetch })).sendMessages([
      new EmailMessage('1', 'b', { to: ['a@example.com'] }),
      new EmailMessage('2', 'b'),
      new EmailMessage('3', 'b', { bcc: ['c@example.com'] }),
    ])
    expect(n).toBe(2)
    expect(calls.map((c) => c.body.subject)).toEqual(['1', '3'])
  })

  it('raises EmailSendError with status and code on API errors', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response(
          JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }),
          { status: 422 },
        ),
    )
    const conn = getConnection(resendBackend({ apiKey: 'k', fetch }))
    const err = await conn
      .sendMessages([new EmailMessage('s', 'b', { to: ['a@example.com'] })])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EmailSendError)
    expect(err).toMatchObject({
      status: 422,
      code: 'validation_error',
      message: 'Resend API error 422: Invalid `to` field.',
    })
  })

  it('wraps network errors and honours failSilently', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof globalThis.fetch
    const m = new EmailMessage('s', 'b', { to: ['a@example.com'] })
    await expect(getConnection(resendBackend({ apiKey: 'k', fetch })).sendMessages([m])).rejects.toThrow(
      'Resend request failed: network down',
    )
    expect(
      await getConnection(resendBackend({ apiKey: 'k', fetch }), { failSilently: true }).sendMessages([m]),
    ).toBe(0)
  })

  it('rejects alternatives it cannot send', async () => {
    const { fetch } = mockFetch(ok)
    const m = new EmailMultiAlternatives('s', 'b', { to: ['a@example.com'] })
    m.attachAlternative('{}', 'application/json')
    await expect(getConnection(resendBackend({ apiKey: 'k', fetch })).sendMessages([m])).rejects.toThrow(
      "cannot send a 'application/json' alternative",
    )
  })

  it('needs an apiKey', () => {
    expect(() => getConnection(resendBackend())).toThrow(ImproperlyConfigured)
  })

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())
    try {
      await withSettings({ EMAIL_BACKEND: resendBackend({ apiKey: 're_x' }) }, () =>
        sendMail('s', 'b', 'from@example.com', ['to@example.com']),
      )
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('cloudflareEmailBackend', () => {
  function binding(fail?: Error & { code?: string }) {
    const sent: CloudflareEmailBuilder[] = []
    return {
      sent,
      send: vi.fn(async (msg: CloudflareEmailBuilder) => {
        if (fail) throw fail
        sent.push(msg)
        return { messageId: `id-${sent.length}` }
      }),
    }
  }

  it("resolves the binding from the request's env and sends the builder shape", async () => {
    const EMAIL = binding()
    const n = await withSettings(
      { EMAIL_BACKEND: cloudflareEmailBackend() },
      async () => {
        const conn = getConnection()
        expect(conn).toBeInstanceOf(CloudflareEmailBackend)
        return conn.sendMessages([richMessage()])
      },
      { EMAIL },
    )
    expect(n).toBe(1)
    const [msg] = EMAIL.sent
    expect(msg).toMatchObject({
      from: { name: 'Shop', email: 'shop@example.com' },
      to: [{ name: 'Jane', email: 'jane@example.com' }],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      replyTo: 'support@example.com',
      subject: 'Order #1',
      text: 'Thanks for your order.',
      html: '<p>Thanks for your order.</p>',
      headers: { 'X-Order': '1', 'List-Unsubscribe': '<mailto:unsub@example.com>' },
    })
    expect(msg.attachments).toHaveLength(2)
    expect(msg.attachments![0]).toMatchObject({
      disposition: 'attachment',
      filename: 'invoice.pdf',
      type: 'application/pdf',
    })
    expect(Array.from(msg.attachments![0].content as Uint8Array)).toEqual([37, 80, 68, 70])
    expect(new TextDecoder().decode(msg.attachments![1].content as Uint8Array)).toBe('héllo')
  })

  it('takes a custom binding name or the binding itself', async () => {
    const MAILER = binding()
    await withSettings(
      { EMAIL_BACKEND: cloudflareEmailBackend({ binding: 'MAILER' }) },
      () => sendMail('s', 'b', 'a@example.com', ['b@example.com']),
      { MAILER },
    )
    expect(MAILER.sent).toHaveLength(1)
    const direct = binding()
    await getConnection(cloudflareEmailBackend({ binding: direct })).sendMessages([
      new EmailMessage('s', 'b', { to: ['x@example.com'] }),
    ])
    expect(direct.sent[0]).toEqual({
      from: 'webmaster@localhost',
      to: ['x@example.com'],
      subject: 's',
      text: 'b',
    })
  })

  it('raises ImproperlyConfigured when the binding is missing', () => {
    expect(() => withSettings({ EMAIL_BACKEND: cloudflareEmailBackend() }, () => getConnection())).toThrow(
      `Send email binding 'EMAIL' was not found in env`,
    )
  })

  it('maps binding errors to EmailSendError with the error code', async () => {
    const err = Object.assign(new Error('sender domain not verified'), { code: 'E_SENDER_NOT_VERIFIED' })
    const EMAIL = binding(err)
    const m = new EmailMessage('s', 'b', { to: ['a@example.com'] })
    const caught = await withSettings({}, () => getConnection(cloudflareEmailBackend()).sendMessages([m]), {
      EMAIL,
    }).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(EmailSendError)
    expect(caught).toMatchObject({ code: 'E_SENDER_NOT_VERIFIED', cause: err })
    const silent = await withSettings(
      {},
      () => getConnection(cloudflareEmailBackend(), { failSilently: true }).sendMessages([m]),
      { EMAIL },
    )
    expect(silent).toBe(0)
  })

  it('rejects several Reply-To addresses and header injection', async () => {
    const EMAIL = binding()
    const conn = getConnection(cloudflareEmailBackend({ binding: EMAIL }))
    await expect(
      conn.sendMessages([
        new EmailMessage('s', 'b', { to: ['a@example.com'], replyTo: ['x@a.com', 'y@a.com'] }),
      ]),
    ).rejects.toThrow('single Reply-To')
    await expect(
      conn.sendMessages([
        new EmailMessage('s', 'b', { to: ['a@example.com'], headers: { 'X-A': 'a\r\nB: c' } }),
      ]),
    ).rejects.toBeInstanceOf(BadHeaderError)
    expect(EMAIL.send).not.toHaveBeenCalled()
  })
})

afterEach(() => vi.restoreAllMocks())
