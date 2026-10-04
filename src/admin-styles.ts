/** Styles shared by the admin pages. */
export const PAGE_STYLES = `
  :root {
    --color-bg: #f6f7f5;
    --color-surface: #ffffff;
    --color-border: #dde1db;
    --color-text: #1f2a24;
    --color-text-muted: #667066;
    --color-accent: #1f7a4d;
    --color-accent-hover: #17603c;
    --color-link: #1f7a4d;
    --color-focus-ring: rgb(31 122 77 / 15%);
    --color-danger: #b3261e;
    --radius: 10px;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-bg: #121714;
      --color-surface: #1b231e;
      --color-border: #34413a;
      --color-text: #e8eee9;
      --color-text-muted: #a3b0a7;
      --color-link: #6fd6a2;
      --color-focus-ring: rgb(111 214 162 / 30%);
      --color-danger: #ff8f86;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    max-width: 640px;
    margin: 2.5rem auto;
    padding: 0 1rem;
    background: var(--color-bg);
    color: var(--color-text);
  }
  h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 1.25rem; }
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--color-border); font-size: 0.9rem; }
  th { color: var(--color-text-muted); font-weight: 500; }
  label { display: block; margin-bottom: 0.85rem; font-size: 0.8rem; font-weight: 500; color: var(--color-text-muted); }
  input {
    width: 100%;
    margin-top: 0.3rem;
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    font-family: inherit;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }
  input:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px var(--color-focus-ring);
  }
  button {
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    font-weight: 600;
    font-family: inherit;
    color: #fff;
    background: var(--color-accent);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
  }
  button:hover { background: var(--color-accent-hover); }
  table button {
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-danger);
    background: transparent;
    border: 1px solid var(--color-border);
  }
  table button:hover { background: var(--color-bg); }
  tr.item td { border-bottom: none; padding-bottom: 0.1rem; }
  tr.item-edit td { padding-top: 0; }
  details.edit summary {
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--color-link);
  }
  .edit-panel {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.6rem;
    margin: 0.4rem 0 0.25rem;
    padding: 0.7rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }
  .edit-panel label { margin: 0; font-size: 0.75rem; }
  .edit-panel label.grow { flex: 1 1 8rem; }
  .edit-panel label.qty { flex: 0 0 5rem; }
  .edit-panel input {
    margin-top: 0.2rem;
    padding: 0.3rem 0.5rem;
    font-size: 0.85rem;
    background: var(--color-surface);
    border-radius: 6px;
  }
  .edit-panel .actions { display: flex; gap: 0.5rem; }
  .edit-panel button {
    padding: 0.35rem 0.8rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: #fff;
    background: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: 6px;
  }
  .edit-panel button:hover { background: var(--color-accent-hover); }
  .edit-panel button.danger {
    color: var(--color-danger);
    background: transparent;
    border-color: var(--color-danger);
  }
  .edit-panel button.danger:hover { background: var(--color-surface); }
  @media (max-width: 30rem) {
    .edit-panel label.grow, .edit-panel label.qty { flex: 1 1 100%; }
  }
  @media (max-width: 30rem) {
    body { margin: 1.25rem auto; }
    .card { padding: 1rem; }
    table.sessions thead { display: none; }
    table.sessions, table.sessions tbody, table.sessions tr, table.sessions td { display: block; width: 100%; }
    table.sessions tr { padding: 0.6rem 0; border-bottom: 1px solid var(--color-border); }
    table.sessions tr:last-child { border-bottom: none; }
    table.sessions td {
      display: flex;
      gap: 0.75rem;
      justify-content: space-between;
      padding: 0.2rem 0;
      border-bottom: none;
      overflow-wrap: anywhere;
      text-align: right;
    }
    table.sessions td::before { flex: none; color: var(--color-text-muted); text-align: left; }
    table.sessions td:nth-child(1) { font-weight: 600; }
    table.sessions td:nth-child(1)::before { content: 'Client'; font-weight: 500; }
    table.sessions td:nth-child(2)::before { content: 'Account'; }
    table.sessions td:nth-child(3)::before { content: 'Last used'; }
    table.sessions td:nth-child(4)::before { content: 'Expires'; }
    table.sessions td:nth-child(5) { justify-content: flex-end; padding-top: 0.4rem; }
  }
  .listing { color: var(--color-text-muted); font-size: 0.8rem; margin-top: 0.15rem; }
  .error { color: var(--color-danger); margin: 0 0 1rem; font-size: 0.9rem; }
  .hint { color: var(--color-text-muted); font-size: 0.85rem; margin: 0 0 1rem; }
  .top-bar { display: flex; align-items: center; justify-content: space-between; }
  .logout {
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-text-muted);
    background: transparent;
    border: 1px solid var(--color-border);
  }
  .logout:hover { background: var(--color-surface); }
`
