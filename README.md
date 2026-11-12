# @ghuri/mail

Django-style email for [Ghuri](https://github.com/ghurijs/ghuri): `sendMail`, `sendMassMail`, `mailAdmins`,
`mailManagers`, `EmailMessage`, `EmailMultiAlternatives` and pluggable backends, the `django.core.mail` API
translated to TypeScript (`snake_case` → `camelCase`, keyword arguments → one options object, everything async).

Runs on Cloudflare Workers (Cloudflare Email Service binding or Resend over `fetch`) and on Node (the same, plus
SMTP from `@ghuri/mail/smtp`). No runtime dependencies.

```bash
npm install @ghuri/mail@next
```

## Quick start

### 1. Settings

Pick a backend in settings. Backends are configs from factory functions, like `d1()` or `kvCache()`; secrets come
from `env` inside your settings factory, never from `process.env` in feature code.

```ts
// src/settings.ts
import { defineSettings } from '@ghuri/core'
import { cloudflareEmailBackend, consoleBackend, resendBackend } from '@ghuri/mail'

export default defineSettings((env) => ({
  // ...
  DEBUG: env.DEBUG === 'true',
  EMAIL_BACKEND:
    env.DEBUG === 'true'
      ? consoleBackend()
      : env.RESEND_API_KEY
        ? resendBackend({ apiKey: env.RESEND_API_KEY })
        : cloudflareEmailBackend({ binding: 'EMAIL' }),
  DEFAULT_FROM_EMAIL: 'Shop <noreply@shop.example.com>',
  SERVER_EMAIL: 'errors@shop.example.com',
  ADMINS: ['Jane <jane@shop.example.com>'],
  MANAGERS: ['orders@shop.example.com'],
  EMAIL_SUBJECT_PREFIX: '[Shop] ',
}))
```

For Cloudflare Email Service add the binding to `wrangler.jsonc` (the sender's domain must be onboarded to Email
Sending):

```jsonc
{ "send_email": [{ "name": "EMAIL" }] }
```

### 2. Sending

```ts
import { EmailMessage, EmailMultiAlternatives, getConnection, mailAdmins, sendMail, sendMassMail } from '@ghuri/mail'

// Returns the number of messages sent (1).
await sendMail('Subject here', 'Here is the message.', 'from@example.com', ['to@example.com'], {
  htmlMessage: '<p>Here is the <b>message</b>.</p>',
})

// fromEmail null → DEFAULT_FROM_EMAIL
await sendMail('Welcome', 'Thanks for signing up.', null, [user.email])

// Several messages over one connection.
await sendMassMail([
  ['Subject', 'Message.', 'from@example.com', ['first@example.com', 'other@example.com']],
  ['Subject', 'Message.', 'from@example.com', ['second@test.com']],
])

// Full control: cc, bcc, replyTo, headers, attachments, alternatives.
const email = new EmailMultiAlternatives('Your invoice', 'Invoice attached.', {
  to: ['Jane <jane@example.com>'],
  bcc: ['archive@example.com'],
  replyTo: ['billing@example.com'],
  headers: { 'List-Unsubscribe': '<mailto:unsubscribe@example.com>' },
})
email.attachAlternative('<p>Invoice attached.</p>', 'text/html')
email.attach('invoice.pdf', pdfBytes) // MIME type guessed from the name
await email.send()

// One connection for many messages.
const connection = getConnection()
await connection.sendMessages([email1, email2, email3])

// ADMINS / MANAGERS, from SERVER_EMAIL, subject prefixed with EMAIL_SUBJECT_PREFIX.
await mailAdmins('Payment webhook failed', String(err))
```

`EmailMessage` takes `new EmailMessage(subject, body, { fromEmail, to, cc, bcc, replyTo, headers, attachments,
connection })` or one object with all of them. It has `attach()`, `recipients()`, `message()` (the MIME structure;
`message().asString()` is the RFC 5322 source), `send(failSilently?)`, `contentSubtype` (`'html'` for an HTML body)
and `extraHeaders`. `EmailMultiAlternatives` adds `attachAlternative(content, mimetype)` and `bodyContains(text)`.

Header injection is refused like in Django: a newline in the subject, an address or a header value raises
`BadHeaderError`.

### 3. Testing

```ts
import { outbox, restoreEmailBackend, useOutbox } from '@ghuri/mail/testing'

beforeEach(() => useOutbox()) // route EMAIL_BACKEND to the in-memory outbox, empty it
afterEach(() => restoreEmailBackend())

it('sends a welcome email', async () => {
  await client.post('/signup/', { form: { email: 'jane@example.com' } })
  expect(outbox).toHaveLength(1)
  expect(outbox[0].subject).toBe('Welcome')
  expect(outbox[0].to).toEqual(['jane@example.com'])
})
```

`outbox` is Django's `mail.outbox`: always the same array, filled by the locmem backend. `clearOutbox()` empties it.
You can also set `EMAIL_BACKEND: locmemBackend()` in test settings instead of `useOutbox()`.

## Backends

| Factory | Where | Notes |
|---|---|---|
| `cloudflareEmailBackend({ binding = 'EMAIL' })` | Workers | Cloudflare Email Service `send_email` binding (`env.EMAIL.send({...})`), resolved from the request's `env`. |
| `resendBackend({ apiKey, baseUrl?, timeout?, fetch? })` | anywhere with `fetch` | `POST https://api.resend.com/emails`, one request per message. |
| `smtpBackend({ host, port, username, password, useTls, useSsl, timeout, tlsOptions })` from `@ghuri/mail/smtp` | Node | Falls back to `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_USE_TLS`, `EMAIL_USE_SSL`, `EMAIL_TIMEOUT`. STARTTLS, implicit TLS, AUTH PLAIN/LOGIN. |
| `consoleBackend({ stream? })` | anywhere | Prints the MIME source (default in `DEBUG`). |
| `locmemBackend()` | anywhere | Appends to `outbox` (`@ghuri/mail/testing`). |
| `dummyBackend()` | anywhere | Does nothing. |

Your own backend: subclass `BaseEmailBackend` (implement `sendMessages()`, optionally `open()` / `close()`) and
return `{ backend: 'name', create: (env, options) => new MyBackend(options) }`.

API backends (Cloudflare, Resend) send structured fields rather than MIME: the body becomes `text` (or `html` when
`contentSubtype` is `'html'`), a `text/html` / `text/plain` alternative fills the other one, and other alternative
types raise `EmailSendError`. Extra `From` / `Reply-To` headers override the fields; `To` / `Cc` headers are not
sent (the providers deliver to the recipient lists). Cloudflare accepts a single Reply-To address and only
`X-*` plus a short allowlist of other custom headers.

Delivery errors raise `EmailSendError` (`status`, `code`, `response`) unless the connection was opened with
`failSilently: true`; then failed messages are not counted.

## Settings

| Setting | Default | |
|---|---|---|
| `EMAIL_BACKEND` | console in `DEBUG`, otherwise none | Sending without it raises `ImproperlyConfigured` (Django's SMTP default does not exist on Workers). |
| `DEFAULT_FROM_EMAIL` | `'webmaster@localhost'` | Sender when none is given. |
| `SERVER_EMAIL` | `'root@localhost'` | Sender of `mailAdmins()` / `mailManagers()`. |
| `EMAIL_SUBJECT_PREFIX` | `'[Ghuri] '` | Prefix for `mailAdmins()` / `mailManagers()`. |
| `ADMINS` / `MANAGERS` | `[]` | Lists of address strings (`'Jane <jane@example.com>'`). |
| `EMAIL_TIMEOUT` | `null` | Seconds for network backends (Resend, SMTP). |

## Differences from Django

- No default SMTP backend: without `EMAIL_BACKEND`, `DEBUG` uses the console backend and anything else raises
  `ImproperlyConfigured` when a connection is opened.
- `message()` returns a `MIMEPart` (`get(header)`, `getParts()`, `getContent()`, `asString()`, `asBytes()`), not a
  Python `email.message.Message`. Everything is 7-bit on the wire (quoted-printable / base64 / RFC 2047).
- `attachFile(path)` is not provided (no file system on Workers): read the file and call `attach()`.
- `ADMINS` / `MANAGERS` take address strings only (Django 6's form), not `(name, email)` tuples.
- `failSilently` behaves the same in every backend: delivery and header errors are swallowed, the message is not
  counted. Configuration errors (`ImproperlyConfigured`) always raise.

## License

MIT
