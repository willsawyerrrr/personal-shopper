export interface HouseholdView {
  members: string[]
  you: string
  invite?: { code: string; expiresAt: number } | undefined
}

export function renderHousehold(household: HouseholdView): string {
  const members = household.members
    .map((email) => `<li>${escapeHtml(email)}${email === household.you ? ' (you)' : ''}</li>`)
    .join('')
  return `<div class="card">
    <h2>Household</h2>
    <p class="hint">Members share these items and one Woolworths account.</p>
    <ul class="members">${members}</ul>
    ${
      household.invite
        ? `<p class="hint">Invite code (single use, expires ${formatTime(household.invite.expiresAt)}): <code>${escapeHtml(household.invite.code)}</code></p>`
        : ''
    }
    <form method="post" action="/household/invites">
      <button type="submit">Create invite code</button>
    </form>
    <form class="add" method="post" action="/household/join">
      <label>Join a household with an invite code
        <input name="code" required autocomplete="off">
      </label>
      <button type="submit" class="danger">Join household</button>
    </form>
    <p class="hint">Joining discards your current items if nobody else is in your household.</p>
    ${
      household.members.length > 1
        ? `<form method="post" action="/household/leave">
      <button type="submit" class="danger">Leave household</button>
    </form>`
        : ''
    }
  </div>`
}

function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
