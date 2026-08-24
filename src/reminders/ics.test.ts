import { describe, expect, it } from 'vitest'
import { parseVTodo } from './ics.ts'

describe('parseVTodo', () => {
  it('extracts the summary from a minimal VTODO', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTODO',
      'SUMMARY:milk',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n')
    expect(parseVTodo(ics)).toEqual({ summary: 'milk', completed: false })
  })

  it('treats a STATUS:COMPLETED VTODO as completed', () => {
    const ics = ['SUMMARY:milk', 'STATUS:COMPLETED'].join('\r\n')
    expect(parseVTodo(ics)).toEqual({ summary: 'milk', completed: true })
  })

  it('unfolds a SUMMARY continued onto the next line', () => {
    const ics = ['SUMMARY:free-range eggs\r\n  from the corner store', 'STATUS:NEEDS-ACTION'].join(
      '\r\n',
    )
    expect(parseVTodo(ics)?.summary).toBe('free-range eggs from the corner store')
  })

  it('unescapes backslash-escaped text', () => {
    expect(parseVTodo('SUMMARY:salt \\, pepper\\; and\\npaprika')?.summary).toBe(
      'salt , pepper; and\npaprika',
    )
  })

  it('ignores parameters on the SUMMARY property', () => {
    expect(parseVTodo('SUMMARY;LANGUAGE=en:milk')?.summary).toBe('milk')
  })

  it('returns undefined when there is no SUMMARY', () => {
    expect(parseVTodo('STATUS:NEEDS-ACTION')).toBeUndefined()
  })
})
