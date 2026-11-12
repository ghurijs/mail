import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type EmailMultiAlternatives,
  getConnection,
  LocmemBackend,
  mailAdmins,
  resendBackend,
  sendMail,
} from '../src/index'
import { clearOutbox, outbox, restoreEmailBackend, useOutbox } from '../src/testing'
import { withSettings } from './helpers'

describe('@ghuri/mail/testing', () => {
  beforeEach(() => useOutbox())
  afterEach(() => restoreEmailBackend())

  it('routes EMAIL_BACKEND to the outbox', async () => {
    const settings = { EMAIL_BACKEND: resendBackend({ apiKey: 'live-key' }), ADMINS: ['admin@example.com'] }
    await withSettings(settings, async () => {
      await sendMail('Welcome', 'Hi Jane', null, ['jane@example.com'], { htmlMessage: '<p>Hi Jane</p>' })
      await mailAdmins('Alert', 'Something happened')
    })
    expect(outbox.map((m) => m.subject)).toEqual(['Welcome', '[Ghuri] Alert'])
    expect((outbox[0] as EmailMultiAlternatives).bodyContains('Hi Jane')).toBe(true)
  })

  it('works without settings at all', async () => {
    expect(getConnection()).toBeInstanceOf(LocmemBackend)
    await sendMail('s', 'b', null, ['a@example.com'])
    expect(outbox).toHaveLength(1)
  })

  it('starts each test with an empty outbox and keeps the same array', () => {
    expect(outbox).toHaveLength(0)
    const same = useOutbox()
    expect(same).toBe(outbox)
  })

  it('clearOutbox() empties it in place', async () => {
    await sendMail('s', 'b', null, ['a@example.com'])
    clearOutbox()
    expect(outbox).toHaveLength(0)
  })

  it('restoreEmailBackend() brings EMAIL_BACKEND back', () => {
    restoreEmailBackend()
    expect(() => getConnection()).toThrow('No Ghuri context')
    expect(withSettings({ DEBUG: true }, () => getConnection())).not.toBeInstanceOf(LocmemBackend)
  })
})
