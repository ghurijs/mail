import { ImproperlyConfigured } from '@ghuri/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BaseEmailBackend,
  type ConnectionOptions,
  ConsoleBackend,
  type EmailBackendConfig,
  EmailMessage,
  EmailMultiAlternatives,
  EmailSendError,
  getConnection,
  LocmemBackend,
  locmemBackend,
  mailAdmins,
  mailManagers,
  sendMail,
  sendMassMail,
} from '../src/index'
import { clearOutbox, outbox } from '../src/testing'
import { decode, withSettings } from './helpers'

/** A backend that records what it was opened with and fails on demand. */
function recordingBackend(fail = false) {
  const opened: ConnectionOptions[] = []
  const sent: EmailMessage[][] = []
  class Recording extends BaseEmailBackend {
    async sendMessages(messages: EmailMessage[]) {
      sent.push(messages)
      return this.sendEach(messages, async () => {
        if (fail) throw new EmailSendError('boom')
      })
    }
  }
  const config: EmailBackendConfig = {
    backend: 'recording',
    create(_env, options) {
      opened.push(options)
      return new Recording(options)
    },
  }
  return { config, opened, sent }
}

beforeEach(() => clearOutbox())
afterEach(() => clearOutbox())

const locmem = { EMAIL_BACKEND: locmemBackend() }

describe('sendMail', () => {
  it('sends one message to every recipient and returns 1', async () => {
    const n = await withSettings(locmem, () =>
      sendMail('Subject here', 'Here is the message.', 'from@example.com', [
        'to@example.com',
        'b@example.com',
      ]),
    )
    expect(n).toBe(1)
    expect(outbox).toHaveLength(1)
    const [m] = outbox
    expect(m).toBeInstanceOf(EmailMultiAlternatives)
    expect(m.subject).toBe('Subject here')
    expect(m.body).toBe('Here is the message.')
    expect(m.fromEmail).toBe('from@example.com')
    expect(m.to).toEqual(['to@example.com', 'b@example.com'])
  })

  it('uses DEFAULT_FROM_EMAIL when fromEmail is null', async () => {
    await withSettings({ ...locmem, DEFAULT_FROM_EMAIL: 'noreply@example.com' }, () =>
      sendMail('s', 'b', null, ['to@example.com']),
    )
    expect(outbox[0].fromEmail).toBe('noreply@example.com')
    await withSettings(locmem, () => sendMail('s', 'b', undefined, ['to@example.com']))
    expect(outbox[1].fromEmail).toBe('webmaster@localhost')
  })

  it('adds htmlMessage as a text/html alternative', async () => {
    await withSettings(locmem, () =>
      sendMail('s', 'plain', 'from@example.com', ['to@example.com'], { htmlMessage: '<p>html</p>' }),
    )
    const m = outbox[0] as EmailMultiAlternatives
    expect(m.alternatives).toEqual([{ content: '<p>html</p>', mimetype: 'text/html' }])
    const [, html] = m.message().getParts()
    expect(decode(html)).toBe('<p>html</p>')
  })

  it('returns 0 for an empty recipient list', async () => {
    expect(await withSettings(locmem, () => sendMail('s', 'b', 'f@example.com', []))).toBe(0)
    expect(outbox).toHaveLength(0)
  })

  it('raises on failure, or returns 0 with failSilently', async () => {
    const { config } = recordingBackend(true)
    await expect(
      withSettings({ EMAIL_BACKEND: config }, () => sendMail('s', 'b', 'f@example.com', ['t@example.com'])),
    ).rejects.toBeInstanceOf(EmailSendError)
    const n = await withSettings({ EMAIL_BACKEND: config }, () =>
      sendMail('s', 'b', 'f@example.com', ['t@example.com'], { failSilently: true }),
    )
    expect(n).toBe(0)
  })

  it('raises BadHeaderError for a subject with a newline', async () => {
    await expect(
      withSettings(locmem, () => sendMail('Subject\nInjection', 'b', 'f@example.com', ['t@example.com'])),
    ).rejects.toThrow("Header values can't contain newlines")
    expect(outbox).toHaveLength(0)
  })

  it('passes failSilently, authUser and authPassword to the backend', async () => {
    const { config, opened } = recordingBackend()
    await withSettings({ EMAIL_BACKEND: config }, () =>
      sendMail('s', 'b', 'f@example.com', ['t@example.com'], {
        failSilently: true,
        authUser: 'user',
        authPassword: 'pass',
      }),
    )
    expect(opened).toEqual([{ failSilently: true, username: 'user', password: 'pass' }])
  })

  it('uses a given connection', async () => {
    const connection = new LocmemBackend()
    expect(await sendMail('s', 'b', 'f@example.com', ['t@example.com'], { connection })).toBe(1)
    expect(outbox[0].connection).toBe(connection)
  })
})

describe('sendMassMail', () => {
  it('sends every message over one connection and returns the count', async () => {
    const { config, opened, sent } = recordingBackend()
    const n = await withSettings({ EMAIL_BACKEND: config }, () =>
      sendMassMail([
        ['Subject', 'Message.', 'from@example.com', ['first@example.com', 'other@example.com']],
        ['Subject', 'Message.', null, ['second@test.com']],
        ['Nobody', 'Message.', null, []],
      ]),
    )
    expect(n).toBe(2)
    expect(opened).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].map((m) => m.to)).toEqual([
      ['first@example.com', 'other@example.com'],
      ['second@test.com'],
      [],
    ])
    expect(sent[0][1].fromEmail).toBe('webmaster@localhost')
  })

  it('counts only successful messages with failSilently', async () => {
    const { config } = recordingBackend(true)
    const n = await withSettings({ EMAIL_BACKEND: config }, () =>
      sendMassMail([['s', 'm', null, ['a@example.com']]], { failSilently: true }),
    )
    expect(n).toBe(0)
  })
})

describe('mailAdmins / mailManagers', () => {
  const settings = {
    ...locmem,
    ADMINS: ['Admin <admin@example.com>', 'ops@example.com'],
    MANAGERS: ['manager@example.com'],
  }

  it('mails ADMINS from SERVER_EMAIL with EMAIL_SUBJECT_PREFIX', async () => {
    await withSettings(settings, () => mailAdmins('Server down', 'It broke.'))
    expect(outbox).toHaveLength(1)
    const [m] = outbox
    expect(m.subject).toBe('[Ghuri] Server down')
    expect(m.fromEmail).toBe('root@localhost')
    expect(m.to).toEqual(['Admin <admin@example.com>', 'ops@example.com'])
    expect(m.body).toBe('It broke.')
  })

  it('mails MANAGERS', async () => {
    await withSettings(settings, () =>
      mailManagers('Broken link', 'See /x/', { htmlMessage: '<p>See /x/</p>' }),
    )
    const m = outbox[0] as EmailMultiAlternatives
    expect(m.to).toEqual(['manager@example.com'])
    expect(m.subject).toBe('[Ghuri] Broken link')
    expect(m.alternatives[0]).toEqual({ content: '<p>See /x/</p>', mimetype: 'text/html' })
  })

  it('honours SERVER_EMAIL and a custom prefix', async () => {
    await withSettings(
      { ...settings, SERVER_EMAIL: 'server@example.com', EMAIL_SUBJECT_PREFIX: '[Shop] ' },
      () => mailAdmins('Hi', 'm'),
    )
    expect(outbox[0].fromEmail).toBe('server@example.com')
    expect(outbox[0].subject).toBe('[Shop] Hi')
  })

  it('does nothing when ADMINS / MANAGERS are empty', async () => {
    await withSettings(locmem, async () => {
      await mailAdmins('s', 'm')
      await mailManagers('s', 'm')
    })
    expect(outbox).toHaveLength(0)
  })

  it('rejects ADMINS that are not a list of strings', async () => {
    await expect(
      withSettings({ ...locmem, ADMINS: [['Admin', 'admin@example.com']] as any }, () =>
        mailAdmins('s', 'm'),
      ),
    ).rejects.toThrow('The ADMINS setting must be a list of email address strings.')
  })

  it('swallows send errors with failSilently', async () => {
    const { config } = recordingBackend(true)
    await withSettings({ EMAIL_BACKEND: config, ADMINS: ['a@example.com'] }, async () => {
      await expect(mailAdmins('s', 'm')).rejects.toBeInstanceOf(EmailSendError)
      await expect(mailAdmins('s', 'm', { failSilently: true })).resolves.toBeUndefined()
    })
  })
})

describe('getConnection', () => {
  it('uses EMAIL_BACKEND and passes the options through', () => {
    const { config, opened } = recordingBackend()
    const conn = withSettings({ EMAIL_BACKEND: config }, () =>
      getConnection(undefined, { failSilently: true, x: 1 }),
    )
    expect(conn.failSilently).toBe(true)
    expect(opened).toEqual([{ failSilently: true, x: 1 }])
  })

  it('takes an explicit backend config', () => {
    expect(getConnection(locmemBackend())).toBeInstanceOf(LocmemBackend)
  })

  it('defaults to the console backend in DEBUG', () => {
    expect(withSettings({ DEBUG: true }, () => getConnection())).toBeInstanceOf(ConsoleBackend)
  })

  it('raises ImproperlyConfigured without EMAIL_BACKEND outside DEBUG', async () => {
    expect(() => withSettings({}, () => getConnection())).toThrow(ImproperlyConfigured)
    expect(() => withSettings({}, () => getConnection())).toThrow('EMAIL_BACKEND is not set')
    await expect(withSettings({}, () => sendMail('s', 'm', null, ['a@example.com']))).rejects.toThrow(
      ImproperlyConfigured,
    )
    // failSilently covers delivery errors, not configuration errors
    await expect(
      withSettings({}, () => sendMail('s', 'm', null, ['a@example.com'], { failSilently: true })),
    ).rejects.toThrow(ImproperlyConfigured)
  })

  it('raises ImproperlyConfigured outside a context', () => {
    expect(() => getConnection()).toThrow('No Ghuri context')
  })

  it('rejects an EMAIL_BACKEND that is not a backend config', () => {
    expect(() => withSettings({ EMAIL_BACKEND: 'smtp' as any }, () => getConnection())).toThrow(
      'EMAIL_BACKEND must be a backend config',
    )
  })

  it('works as a reusable connection', async () => {
    const conn = withSettings(locmem, () => getConnection())
    expect(await conn.open()).toBe(false)
    const messages = [
      new EmailMessage('a', 'b', { to: ['a@example.com'], connection: conn }),
      new EmailMessage('c', 'd', { to: ['b@example.com'], connection: conn }),
    ]
    expect(await conn.sendMessages(messages)).toBe(2)
    await conn.close()
    expect(outbox.map((m) => m.subject)).toEqual(['a', 'c'])
  })

  it('EmailMessage.send() opens and keeps a connection', async () => {
    const m = new EmailMessage('s', 'b', { to: ['a@example.com'] })
    expect(await withSettings(locmem, () => m.send())).toBe(1)
    expect(m.connection).toBeInstanceOf(LocmemBackend)
  })
})
