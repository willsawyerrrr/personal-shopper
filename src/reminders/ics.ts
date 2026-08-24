// Reminders are queued as VTODOs, one per iCloud CalDAV object. This pulls
// just the two properties the sync loop needs — SUMMARY (the spoken item
// text) and STATUS — without pulling in a full iCalendar parser.

export interface VTodo {
  summary: string
  completed: boolean
}

export function parseVTodo(icsData: string): VTodo | undefined {
  const unfolded = unfoldLines(icsData)
  const summary = readProperty(unfolded, 'SUMMARY')
  if (summary === undefined) {
    return undefined
  }
  const status = readProperty(unfolded, 'STATUS')
  return { summary: unescapeText(summary), completed: status === 'COMPLETED' }
}

// RFC 5545 §3.1: a line folded across multiple physical lines resumes with a
// leading space or tab, which this removes to rejoin it into one logical line.
function unfoldLines(ics: string): string[] {
  const lines = ics.split(/\r\n|\n|\r/)
  const unfolded: string[] = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1)
    } else {
      unfolded.push(line)
    }
  }
  return unfolded
}

function readProperty(lines: string[], name: string): string | undefined {
  const prefix = new RegExp(`^${name}(;[^:]*)?:`)
  const line = lines.find((candidate) => prefix.test(candidate))
  return line?.replace(prefix, '')
}

// RFC 5545 §3.3.11: TEXT values escape backslash, comma, semicolon, and newline.
function unescapeText(value: string): string {
  return value.replace(/\\(.)/g, (_match, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char,
  )
}
