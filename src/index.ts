// @ghuri/mail — Django-style email (django.core.mail) for Ghuri. Workers-safe: the SMTP backend lives in
// `@ghuri/mail/smtp`, the test outbox in `@ghuri/mail/testing`.

export {
  forbidMultiLineHeaders,
  formatAddress,
  type ParsedAddress,
  parseAddress,
  sanitizeAddress,
} from './address'
export {
  type MailAdminsOptions,
  type MassMailTuple,
  mailAdmins,
  mailManagers,
  type SendMailOptions,
  type SendMassMailOptions,
  sendMail,
  sendMassMail,
} from './api'
export { BaseEmailBackend, type ConnectionOptions, type EmailBackendConfig } from './backends/base'
export {
  type CloudflareAddress,
  CloudflareEmailBackend,
  type CloudflareEmailBackendOptions,
  type CloudflareEmailBuilder,
  cloudflareEmailBackend,
  type SendEmailBinding,
} from './backends/cloudflare'
export {
  ConsoleBackend,
  type ConsoleBackendOptions,
  consoleBackend,
  type WritableLike,
} from './backends/console'
export { DummyBackend, dummyBackend } from './backends/dummy'
export { LocmemBackend, locmemBackend } from './backends/locmem'
export { ResendBackend, type ResendBackendOptions, resendBackend } from './backends/resend'
export { getConnection } from './connection'
export { BadHeaderError, EmailSendError, type EmailSendErrorOptions } from './errors'
export {
  type AttachmentInput,
  DEFAULT_ATTACHMENT_MIME_TYPE,
  type EmailAlternative,
  type EmailAttachment,
  EmailMessage,
  type EmailMessageOptions,
  EmailMultiAlternatives,
  type EmailMultiAlternativesOptions,
  formatDate,
  makeMsgid,
} from './message'
export { type EmailContent, MIMEPart } from './mime'
export { DEFAULT_EMAIL_SUBJECT_PREFIX, DEFAULT_FROM_EMAIL, DEFAULT_SERVER_EMAIL } from './settings'
