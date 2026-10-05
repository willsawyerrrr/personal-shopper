import { escapeHtml } from './html.ts'

export interface HouseholdView {
  members: string[]
  you: string
  invite?: { code: string; expiresAt: number } | undefined
}

export function renderHousehold(household: HouseholdView): string {
  const members = household.members
    .map((email) => `<li>${escapeHtml(email)}${email === household.you ? ' (you)' : ''}</li>`)
    .join('')
  return `<section class="household">
    <h2>Household</h2>
    <p class="hint">Members share these items and one Woolworths account.</p>
    <ul class="members">${members}</ul>
    ${
      household.invite
        ? `<p class="hint">Invite code (single use, expires ${formatTime(household.invite.expiresAt)}): <code>${escapeHtml(household.invite.code)}</code></p>`
        : ''
    }
    <form class="actions" method="post" action="/household/invites">
      <button type="submit">Create invite code</button>
    </form>
    <form method="post" action="/household/join">
      <label>Invite code
        <input name="code" required autocomplete="off">
      </label>
      <div class="actions">
        <button type="submit">Join household</button>${
          household.members.length > 1
            ? `
        <button type="submit" class="secondary" formaction="/household/leave" formnovalidate>Leave household</button>`
            : ''
        }
      </div>
      <p class="hint">Joining discards your current items if nobody else is in your household.</p>
    </form>
  </section>`
}

function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
