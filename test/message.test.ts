import { describe, expect, it } from 'vitest'
import {
  BadHeaderError,
  DEFAULT_ATTACHMENT_MIME_TYPE,
  EmailMessage,
  EmailMultiAlternatives,
  formatDate,
  parseAddress,
  sanitizeAddress,
} from '../src/index'
import { decode, withSettings } from './helpers'

describe('EmailMessage', () => {
  it('takes positional subject/body plus options, or one options object', () => {
    const a = new EmailMessage('Subject', 'Content', {
      fromEmail: 'from@example.com',
      to: ['to@example.com'],
    })
    const b = new EmailMessage({
      subject: 'Subject',
      body: 'Content',
      fromEmail: 'from@example.com',
      to: ['to@example.com'],
    })
    for (const m of [a, b]) {
      expect(m.subject).toBe('Subject')
      expect(m.body).toBe('Content')
      expect(m.fromEmail).toBe('from@example.com')
      expect(m.to).toEqual(['to@example.com'])
    }
  })

  it("defaults the sender to DEFAULT_FROM_EMAIL ('webmaster@localhost')", () => {
    expect(new EmailMessage('s', 'b').fromEmail).toBe('webmaster@localhost')
    withSettings({ DEFAULT_FROM_EMAIL: 'site@example.com' }, () => {
      expect(new EmailMessage('s', 'b').fromEmail).toBe('site@example.com')
      expect(new EmailMessage('s', 'b', { fromEmail: null }).fromEmail).toBe('site@example.com')
    })
  })

  it('rejects a string where a list is expected', () => {
    expect(() => new EmailMessage('s', 'b', { to: 'a@example.com' as any })).toThrow(
      '"to" argument must be a list or tuple',
    )
    expect(() => new EmailMessage('s', 'b', { cc: 'a@example.com' as any })).toThrow(TypeError)
    expect(() => new EmailMessage('s', 'b', { bcc: 'a@example.com' as any })).toThrow(TypeError)
    expect(() => new EmailMessage('s', 'b', { replyTo: 'a@example.com' as any })).toThrow(TypeError)
  })

  it('recipients() are to + cc + bcc, empty entries dropped', () => {
    const m = new EmailMessage('s', 'b', {
      to: ['to1@example.com', ''],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
    })
    expect(m.recipients()).toEqual(['to1@example.com', 'cc@example.com', 'bcc@example.com'])
  })

  it('builds headers like Django (bcc is never a header)', () => {
    const m = new EmailMessage('Subject', 'Content', {
      fromEmail: 'from@example.com',
      to: ['to1@example.com', 'Other <to2@example.com>'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      replyTo: ['reply@example.com'],
      headers: { 'X-Tag': 'welcome' },
    })
    const msg = m.message()
    expect(msg.get('Content-Type')).toBe('text/plain; charset="utf-8"')
    expect(msg.get('MIME-Version')).toBe('1.0')
    expect(msg.get('Content-Transfer-Encoding')).toBe('7bit')
    expect(msg.get('Subject')).toBe('Subject')
    expect(msg.get('From')).toBe('from@example.com')
    expect(msg.get('To')).toBe('to1@example.com, Other <to2@example.com>')
    expect(msg.get('Cc')).toBe('cc@example.com')
    expect(msg.get('Reply-To')).toBe('reply@example.com')
    expect(msg.get('Bcc')).toBeUndefined()
    expect(msg.get('X-Tag')).toBe('welcome')
    expect(msg.get('Date')).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/)
    expect(msg.get('Message-ID')).toMatch(/^<\d+\.[0-9a-f]{16}@example\.com>$/)
    expect(msg.headers.map(([n]) => n).slice(0, 3)).toEqual([
      'Content-Type',
      'MIME-Version',
      'Content-Transfer-Encoding',
    ])
    expect(decode(msg)).toBe('Content')
    const source = msg.asString()
    expect(source).toContain('\r\n\r\nContent')
    expect(source).not.toMatch(/[^\r]\n/)
  })

  it('omits Cc / Reply-To when empty', () => {
    const msg = new EmailMessage('s', 'b', { to: ['a@example.com'] }).message()
    expect(msg.get('Cc')).toBeUndefined()
    expect(msg.get('Reply-To')).toBeUndefined()
  })

  it('lets extra headers override From, To, Cc, Reply-To, Date and Message-ID', () => {
    const msg = new EmailMessage('s', 'b', {
      fromEmail: 'bounce@example.com',
      to: ['list-member@example.com'],
      headers: {
        From: 'Team <team@example.com>',
        to: 'list@example.com',
        'Reply-To': 'r1@example.com, r2@example.com',
        Date: 'Fri, 09 Nov 2001 01:08:47 -0000',
        'Message-ID': '<foo@example.com>',
      },
    }).message()
    expect(msg.get('From')).toBe('Team <team@example.com>')
    expect(msg.get('To')).toBe('list@example.com')
    expect(msg.getAll('To')).toHaveLength(1)
    expect(msg.get('Reply-To')).toBe('r1@example.com, r2@example.com')
    expect(msg.get('Date')).toBe('Fri, 09 Nov 2001 01:08:47 -0000')
    expect(msg.get('Message-ID')).toBe('<foo@example.com>')
  })

  it('encodes non-ASCII subjects, names and bodies', () => {
    const msg = new EmailMessage('Grüße aus Dhaka — ঘুড়ি', 'Héllo wörld\nline two', {
      fromEmail: 'Jörg Müller <jorg@example.com>',
      to: ['Ana Ñ <ana@exämple.com>'],
    }).message()
    expect(msg.get('Subject')).toMatch(/^=\?utf-8\?b\?/)
    expect(msg.get('From')).toMatch(/^=\?utf-8\?b\?.+\?= <jorg@example\.com>$/)
    expect(msg.get('To')).toContain('<ana@xn--exmple-cua.com>')
    expect(msg.get('Content-Transfer-Encoding')).toBe('quoted-printable')
    expect(decode(msg)).toBe('Héllo wörld\r\nline two')
    const subject = msg.get('Subject')!
    const decoded = subject
      .split(/\r\n /)
      .map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0))))
      .join('')
    expect(decoded).toBe('Grüße aus Dhaka — ঘুড়ি')
  })

  it('uses quoted-printable for long lines', () => {
    const msg = new EmailMessage('s', 'x'.repeat(1200), { to: ['a@example.com'] }).message()
    expect(msg.get('Content-Transfer-Encoding')).toBe('quoted-printable')
    expect(
      msg
        .asString()
        .split('\r\n')
        .every((l) => l.length <= 998),
    ).toBe(true)
    expect(decode(msg)).toBe('x'.repeat(1200))
  })

  it('sends HTML bodies with contentSubtype = "html"', () => {
    const m = new EmailMessage('s', '<p>Hi</p>', { to: ['a@example.com'] })
    m.contentSubtype = 'html'
    expect(m.message().get('Content-Type')).toBe('text/html; charset="utf-8"')
  })

  describe('header injection (BadHeaderError)', () => {
    it('in the subject', () => {
      const m = new EmailMessage('Subject\nInjection Test', 'Content', { to: ['to@example.com'] })
      expect(() => m.message()).toThrow(BadHeaderError)
      expect(() => m.message()).toThrow("Header values can't contain newlines")
      expect(() => new EmailMessage('Subject\rInjection', 'c', { to: ['a@example.com'] }).message()).toThrow(
        BadHeaderError,
      )
    })

    it('in addresses', () => {
      const bad = ['to@example.com\nBcc: evil@example.com']
      expect(() => new EmailMessage('s', 'b', { to: bad }).message()).toThrow(BadHeaderError)
      expect(() => new EmailMessage('s', 'b', { cc: bad }).message()).toThrow(BadHeaderError)
      expect(() => new EmailMessage('s', 'b', { replyTo: bad }).message()).toThrow(BadHeaderError)
      expect(() =>
        new EmailMessage('s', 'b', { fromEmail: 'a@example.com\r\nX: y', to: ['a@example.com'] }).message(),
      ).toThrow(BadHeaderError)
    })

    it('in extra header values and names', () => {
      expect(() =>
        new EmailMessage('s', 'b', {
          to: ['a@example.com'],
          headers: { 'X-Foo': 'a\nBcc: evil@example.com' },
        }).message(),
      ).toThrow(BadHeaderError)
      expect(() =>
        new EmailMessage('s', 'b', { to: ['a@example.com'], headers: { 'X-Foo\nBcc': 'x' } }).message(),
      ).toThrow(BadHeaderError)
      expect(() =>
        new EmailMessage('s', 'b', { to: ['a@example.com'], headers: { 'Bad: Name': 'x' } }).message(),
      ).toThrow(BadHeaderError)
    })

    it('in attachment file names', () => {
      const m = new EmailMessage('s', 'b', { to: ['a@example.com'] }).attach('a\nb.txt', 'x')
      expect(() => m.message()).toThrow(BadHeaderError)
    })
  })

  describe('attachments', () => {
    it('wraps body and attachments in multipart/mixed', () => {
      const m = new EmailMessage('s', 'Body', { to: ['a@example.com'] })
      m.attach('notes.txt', 'Some notes')
      m.attach('data.bin', new Uint8Array([0, 1, 2, 255]), 'application/x-custom')
      m.attach({ filename: 'report.pdf', content: new Uint8Array([37, 80, 68, 70]) })
      const msg = m.message()
      expect(msg.getContentType()).toBe('multipart/mixed')
      expect(msg.get('MIME-Version')).toBe('1.0')
      const [body, txt, bin, pdf] = msg.getParts()
      expect(decode(body)).toBe('Body')
      expect(txt.get('Content-Type')).toBe('text/plain; charset="utf-8"')
      expect(txt.get('Content-Disposition')).toBe('attachment; filename="notes.txt"')
      expect(decode(txt)).toBe('Some notes')
      expect(bin.get('Content-Type')).toBe('application/x-custom')
      expect(bin.get('Content-Transfer-Encoding')).toBe('base64')
      expect(Array.from(bin.getContent() as Uint8Array)).toEqual([0, 1, 2, 255])
      expect(pdf.getContentType()).toBe('application/pdf')
      expect(msg.asString()).toContain(`--${msg.boundary}--`)
    })

    it('accepts attachments in the constructor as objects or tuples', () => {
      const m = new EmailMessage('s', 'b', {
        attachments: [
          ['a.csv', 'x,y\n1,2'],
          { filename: 'b.png', content: new ArrayBuffer(3), mimetype: null },
        ],
      })
      expect(m.attachments.map((a) => [a.filename, a.mimetype])).toEqual([
        ['a.csv', 'text/csv'],
        ['b.png', 'image/png'],
      ])
    })

    it('guesses the MIME type, falling back to application/octet-stream', () => {
      const m = new EmailMessage('s', 'b')
      m.attach('archive.unknownext', 'x')
      m.attach(null, 'no name')
      expect(m.attachments.map((a) => a.mimetype)).toEqual([
        DEFAULT_ATTACHMENT_MIME_TYPE,
        DEFAULT_ATTACHMENT_MIME_TYPE,
      ])
    })

    it('decodes text attachments given as bytes; undecodable ones become octet-stream', () => {
      const m = new EmailMessage('s', 'b')
      m.attach('ok.txt', new TextEncoder().encode('héllo'), 'text/plain')
      m.attach('bad.txt', new Uint8Array([0xff, 0xfe, 0xfd]), 'text/plain')
      expect(m.attachments[0]).toEqual({ filename: 'ok.txt', content: 'héllo', mimetype: 'text/plain' })
      expect(m.attachments[1].mimetype).toBe(DEFAULT_ATTACHMENT_MIME_TYPE)
    })

    it('encodes non-ASCII file names (RFC 2231)', () => {
      const m = new EmailMessage('s', 'b', { to: ['a@example.com'] }).attach(
        'résumé.pdf',
        new Uint8Array([1]),
      )
      expect(m.message().getParts()[1].get('Content-Disposition')).toBe(
        "attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf",
      )
    })

    it('skips an empty body', () => {
      const m = new EmailMessage('s', '', { to: ['a@example.com'] }).attach('a.txt', 'x')
      expect(m.message().getParts()).toHaveLength(1)
    })

    it('requires content', () => {
      expect(() => (new EmailMessage('s', 'b') as any).attach('a.txt')).toThrow('content must be provided.')
    })
  })

  it('send() without recipients returns 0 and opens no connection', async () => {
    const m = new EmailMessage('s', 'b')
    expect(await m.send()).toBe(0)
    expect(m.connection).toBeNull()
  })
})

describe('EmailMultiAlternatives', () => {
  it('puts body and alternatives in multipart/alternative', () => {
    const m = new EmailMultiAlternatives('s', 'Plain', { to: ['a@example.com'] })
    m.attachAlternative('<p>HTML</p>', 'text/html')
    const msg = m.message()
    expect(msg.getContentType()).toBe('multipart/alternative')
    const [plain, html] = msg.getParts()
    expect(plain.getContentType()).toBe('text/plain')
    expect(html.getContentType()).toBe('text/html')
    expect(decode(html)).toBe('<p>HTML</p>')
  })

  it('takes alternatives in the constructor', () => {
    const m = new EmailMultiAlternatives('s', 'b', {
      alternatives: [['<b>b</b>', 'text/html'], { content: 'x', mimetype: 'text/x-amp-html' }],
    })
    expect(m.alternatives).toEqual([
      { content: '<b>b</b>', mimetype: 'text/html' },
      { content: 'x', mimetype: 'text/x-amp-html' },
    ])
  })

  it('nests alternatives inside multipart/mixed with attachments', () => {
    const m = new EmailMultiAlternatives('s', 'Plain', { to: ['a@example.com'] })
    m.attachAlternative('<p>HTML</p>', 'text/html')
    m.attach('a.pdf', new Uint8Array([1, 2]))
    const msg = m.message()
    expect(msg.getContentType()).toBe('multipart/mixed')
    const [alt, pdf] = msg.getParts()
    expect(alt.getContentType()).toBe('multipart/alternative')
    expect(alt.getParts()).toHaveLength(2)
    expect(pdf.getContentType()).toBe('application/pdf')
    expect(msg.walk()).toHaveLength(4)
  })

  it('keeps the alternative container even when the body is empty', () => {
    const m = new EmailMultiAlternatives('s', '', { to: ['a@example.com'] })
    m.attachAlternative('<p>only html</p>', 'text/html')
    m.attach('a.txt', 'x')
    const [alt] = m.message().getParts()
    expect(alt.getContentType()).toBe('multipart/alternative')
    expect(alt.getParts()).toHaveLength(1)
  })

  it('bodyContains() checks the body and every text alternative', () => {
    const m = new EmailMultiAlternatives('s', 'I am content', { to: ['a@example.com'] })
    expect(m.bodyContains('I am content')).toBe(true)
    m.attachAlternative('<p>I am content too</p>', 'text/html')
    expect(m.bodyContains('I am content')).toBe(true)
    expect(m.bodyContains('too')).toBe(false)
    m.attachAlternative('binary-ish', 'application/octet-stream')
    expect(m.bodyContains('I am content')).toBe(true)
  })

  it('attachAlternative() requires content and mimetype', () => {
    expect(() => new EmailMultiAlternatives().attachAlternative('x', '')).toThrow(
      'Both content and mimetype must be provided.',
    )
  })
})

describe('addresses', () => {
  it('parses display names, quoted names and bare addresses', () => {
    expect(parseAddress('jane@example.com')).toEqual({ name: '', email: 'jane@example.com' })
    expect(parseAddress('Jane Doe <jane@example.com>')).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
    })
    expect(parseAddress('"Doe, Jane" <jane@example.com>')).toEqual({
      name: 'Doe, Jane',
      email: 'jane@example.com',
    })
    expect(() => parseAddress('not an address')).toThrow(BadHeaderError)
  })

  it('sanitizes for headers: quotes specials, punycodes domains', () => {
    expect(sanitizeAddress('Doe, Jane <jane@example.com>')).toBe('"Doe, Jane" <jane@example.com>')
    expect(sanitizeAddress('to@éxample.com')).toBe('to@xn--xample-9ua.com')
  })

  it('formats dates in RFC 5322 form', () => {
    expect(formatDate(new Date(Date.UTC(2026, 10, 12, 9, 5, 3)))).toBe('Thu, 12 Nov 2026 09:05:03 +0000')
  })
})
