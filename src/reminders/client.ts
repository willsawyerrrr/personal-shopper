import { createDAVClient, type DAVCalendar } from 'tsdav'
import { parseVTodo } from './ics.ts'

const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com'

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>

export interface QueuedReminder {
  url: string
  etag: string | undefined
  title: string
}

export interface RemindersClient {
  listPending(): Promise<QueuedReminder[]>
  remove(reminder: QueuedReminder): Promise<void>
}

export class ICloudRemindersClient implements RemindersClient {
  private client: DAVClient | undefined

  constructor(
    private readonly username: string,
    private readonly appSpecificPassword: string,
    private readonly listName: string,
  ) {}

  async listPending(): Promise<QueuedReminder[]> {
    const calendar = await this.findList()
    const objects = await (await this.connect()).fetchCalendarObjects({ calendar })
    return objects.flatMap(({ url, etag, data }) => {
      const vtodo = data ? parseVTodo(String(data)) : undefined
      return vtodo && !vtodo.completed ? [{ url, etag, title: vtodo.summary }] : []
    })
  }

  async remove(reminder: QueuedReminder): Promise<void> {
    await (
      await this.connect()
    ).deleteCalendarObject({
      calendarObject: { url: reminder.url, ...(reminder.etag && { etag: reminder.etag }) },
    })
  }

  private async findList(): Promise<DAVCalendar> {
    const client = await this.connect()
    const calendars = await client.fetchCalendars()
    const list = calendars.find(
      (calendar) =>
        calendar.components?.includes('VTODO') && calendar.displayName === this.listName,
    )
    if (!list) {
      throw new Error(`No iCloud Reminders list named "${this.listName}" was found`)
    }
    return list
  }

  private async connect(): Promise<DAVClient> {
    if (!this.client) {
      this.client = await createDAVClient({
        serverUrl: ICLOUD_CALDAV_URL,
        credentials: { username: this.username, password: this.appSpecificPassword },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      })
    }
    return this.client
  }
}
