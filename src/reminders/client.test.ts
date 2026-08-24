import { describe, expect, it, vi } from 'vitest'
import { ICloudRemindersClient } from './client.ts'

const { fetchCalendars, fetchCalendarObjects, deleteCalendarObject } = vi.hoisted(() => ({
  fetchCalendars: vi.fn(),
  fetchCalendarObjects: vi.fn(),
  deleteCalendarObject: vi.fn(),
}))

vi.mock('tsdav', () => ({
  createDAVClient: vi.fn().mockResolvedValue({
    fetchCalendars,
    fetchCalendarObjects,
    deleteCalendarObject,
  }),
}))

const LIST = {
  url: 'https://caldav.icloud.com/1234/lists/abcd/',
  displayName: 'Shopping List',
  components: ['VTODO'],
}

describe('ICloudRemindersClient', () => {
  it('lists incomplete VTODOs from the matching list as pending reminders', async () => {
    fetchCalendars.mockResolvedValue([
      { url: '...', displayName: 'Other List', components: ['VTODO'] },
      LIST,
    ])
    fetchCalendarObjects.mockResolvedValue([
      { url: 'https://example.com/1.ics', etag: 'e1', data: 'SUMMARY:milk' },
      { url: 'https://example.com/2.ics', etag: 'e2', data: 'SUMMARY:eggs\r\nSTATUS:COMPLETED' },
    ])

    const client = new ICloudRemindersClient(
      'me@example.com',
      'app-specific-password',
      'Shopping List',
    )
    const pending = await client.listPending()

    expect(fetchCalendarObjects).toHaveBeenCalledWith({ calendar: LIST })
    expect(pending).toEqual([{ url: 'https://example.com/1.ics', etag: 'e1', title: 'milk' }])
  })

  it('throws when no list matches the configured name', async () => {
    fetchCalendars.mockResolvedValue([])
    const client = new ICloudRemindersClient(
      'me@example.com',
      'app-specific-password',
      'Shopping List',
    )
    await expect(client.listPending()).rejects.toThrow(/Shopping List/)
  })

  it('deletes the reminder by url and etag on remove', async () => {
    fetchCalendars.mockResolvedValue([LIST])
    deleteCalendarObject.mockResolvedValue(new Response())
    const client = new ICloudRemindersClient(
      'me@example.com',
      'app-specific-password',
      'Shopping List',
    )

    await client.remove({ url: 'https://example.com/1.ics', etag: 'e1', title: 'milk' })

    expect(deleteCalendarObject).toHaveBeenCalledWith({
      calendarObject: { url: 'https://example.com/1.ics', etag: 'e1' },
    })
  })
})
