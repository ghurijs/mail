import { ImproperlyConfigured } from '@ghuri/core'
import type { BaseEmailBackend, ConnectionOptions } from './backends/base'
import { getConnection } from './connection'
import { EmailMessage, EmailMultiAlternatives } from './message'
import { DEFAULT_EMAIL_SUBJECT_PREFIX, DEFAULT_SERVER_EMAIL, mailSetting } from './settings'

export interface SendMailOptions {
  /** Swallow delivery errors and return 0 instead (default false). */
  failSilently?: boolean
  /** Username for backends that authenticate (SMTP); defaults to the backend's own setting. */
  authUser?: string
  /** Password for backends that authenticate (SMTP). */
  authPassword?: string
  /** Connection to use instead of a new `getConnection()`. */
  connection?: BaseEmailBackend | null
  /** HTML version of the message, sent as a `text/html` alternative. */
  htmlMessage?: string | null
}

export type SendMassMailOptions = Omit<SendMailOptions, 'htmlMessage'>

export interface MailAdminsOptions {
  failSilently?: boolean
  connection?: BaseEmailBackend | null
  htmlMessage?: string | null
}

function connectionFor(opts: SendMassMailOptions): BaseEmailBackend {
  if (opts.connection) return opts.connection
  const options: ConnectionOptions = { failSilently: !!opts.failSilently }
  if (opts.authUser !== undefined) options.username = opts.authUser
  if (opts.authPassword !== undefined) options.password = opts.authPassword
  return getConnection(undefined, options)
}

/**
 * Send one message to every address in `recipientList` (they all see each other in `To`). Returns the number of
 * messages sent (0 or 1). `fromEmail` defaults to `DEFAULT_FROM_EMAIL`.
 *
 * ```ts
 * await sendMail('Subject here', 'Here is the message.', 'from@example.com', ['to@example.com'])
 * ```
 */
export async function sendMail(
  subject: string,
  message: string,
  fromEmail: string | null | undefined,
  recipientList: string[],
  opts: SendMailOptions = {},
): Promise<number> {
  const connection = connectionFor(opts)
  const mail = new EmailMultiAlternatives(subject, message, { fromEmail, to: recipientList, connection })
  if (opts.htmlMessage) mail.attachAlternative(opts.htmlMessage, 'text/html')
  return mail.send()
}

/** `[subject, message, fromEmail, recipientList]` for `sendMassMail()`. */
export type MassMailTuple = [
  subject: string,
  message: string,
  fromEmail: string | null | undefined,
  recipientList: string[],
]

/**
 * Send several messages over one connection. Returns the number sent.
 *
 * ```ts
 * await sendMassMail([
 *   ['Subject', 'Message.', 'from@example.com', ['first@example.com', 'other@example.com']],
 *   ['Subject', 'Message.', 'from@example.com', ['second@test.com']],
 * ])
 * ```
 */
export async function sendMassMail(
  datatuple: MassMailTuple[],
  opts: SendMassMailOptions = {},
): Promise<number> {
  const connection = connectionFor(opts)
  const messages = datatuple.map(
    ([subject, message, fromEmail, recipients]) =>
      new EmailMessage(subject, message, { fromEmail, to: recipients, connection }),
  )
  return connection.sendMessages(messages)
}

async function mailRecipients(
  setting: 'ADMINS' | 'MANAGERS',
  subject: string,
  message: string,
  opts: MailAdminsOptions,
): Promise<void> {
  const recipients = mailSetting(setting, [])
  if (!Array.isArray(recipients) || recipients.some((r) => typeof r !== 'string')) {
    throw new ImproperlyConfigured(`The ${setting} setting must be a list of email address strings.`)
  }
  if (!recipients.length) return
  const mail = new EmailMultiAlternatives(
    `${mailSetting('EMAIL_SUBJECT_PREFIX', DEFAULT_EMAIL_SUBJECT_PREFIX)}${subject}`,
    message,
    {
      fromEmail: mailSetting('SERVER_EMAIL', DEFAULT_SERVER_EMAIL),
      to: recipients,
      connection: opts.connection ?? null,
    },
  )
  if (opts.htmlMessage) mail.attachAlternative(opts.htmlMessage, 'text/html')
  await mail.send(!!opts.failSilently)
}

/** Email the site admins (`ADMINS`) from `SERVER_EMAIL`, subject prefixed with `EMAIL_SUBJECT_PREFIX`. */
export async function mailAdmins(
  subject: string,
  message: string,
  opts: MailAdminsOptions = {},
): Promise<void> {
  await mailRecipients('ADMINS', subject, message, opts)
}

/** Email the site managers (`MANAGERS`) from `SERVER_EMAIL`, subject prefixed with `EMAIL_SUBJECT_PREFIX`. */
export async function mailManagers(
  subject: string,
  message: string,
  opts: MailAdminsOptions = {},
): Promise<void> {
  await mailRecipients('MANAGERS', subject, message, opts)
}
