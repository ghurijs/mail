# Changelog

## 0.1.0-alpha.0 (unreleased)

Initial alpha.

- `sendMail()`, `sendMassMail()`, `mailAdmins()`, `mailManagers()` (Django's `django.core.mail` functions).
- `EmailMessage` and `EmailMultiAlternatives`: cc, bcc, replyTo, extra headers, attachments (`attach()`, MIME type
  guessing), alternatives (`attachAlternative()`), `recipients()`, `message()` (MIME, RFC 2047/2231 encoding,
  IDNA domains), `send()`, `bodyContains()`.
- Header-injection protection: `BadHeaderError` for newlines in subjects, addresses, header names and values.
- `getConnection()` and `BaseEmailBackend` (`open()`, `close()`, `sendMessages()`); `EmailSendError` for delivery
  failures, `failSilently` support.
- Backends: `cloudflareEmailBackend()` (Cloudflare Email Service `send_email` binding), `resendBackend()` (Resend HTTP
  API over `fetch`), `consoleBackend()`, `locmemBackend()`, `dummyBackend()`.
- `@ghuri/mail/smtp`: `smtpBackend()` on `node:net` / `node:tls` (STARTTLS, implicit TLS, AUTH PLAIN/LOGIN), reading
  Django's `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_HOST_USER` / `EMAIL_HOST_PASSWORD` / `EMAIL_USE_TLS` /
  `EMAIL_USE_SSL` settings.
- Settings: `EMAIL_BACKEND`, `DEFAULT_FROM_EMAIL`, `SERVER_EMAIL`, `EMAIL_SUBJECT_PREFIX`, `ADMINS`, `MANAGERS`,
  `EMAIL_TIMEOUT`. Without `EMAIL_BACKEND`, `DEBUG` uses the console backend; otherwise sending raises
  `ImproperlyConfigured`.
- `@ghuri/mail/testing`: `outbox`, `clearOutbox()`, `useOutbox()`, `restoreEmailBackend()`.
