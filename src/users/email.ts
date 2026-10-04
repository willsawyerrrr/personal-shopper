/** Lower-cases and trims an email, the form every per-user lookup is keyed on. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
