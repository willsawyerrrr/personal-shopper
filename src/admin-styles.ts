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
  section + section {
    margin-top: 2rem;
    padding-top: 2rem;
    border-top: 1px solid var(--color-border);
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
  .items { --cols: minmax(0, 1fr) minmax(0, 9rem) 4.5rem 8.5rem; }
  .item-head, form.item {
    display: grid;
    grid-template-columns: var(--cols);
    gap: 0.5rem;
    align-items: start;
  }
  .item-head { padding-bottom: 0.4rem; font-size: 0.9rem; color: var(--color-text-muted); font-weight: 500; }
  .item-head span { padding-left: 0.45rem; }
  .item-head { border-bottom: 1px solid var(--color-border); margin-bottom: 0.25rem; }
  form.item { position: relative; padding: 0.5rem 0; }
  form.item + form.item { border-top: 1px solid var(--color-border); }
  form.item label { margin: 0; }
  form.item .edit-toggle {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
  }
  form.item .cell .edit { display: none; }
  form.item .edit-toggle:checked ~ .cell .view { display: none; }
  form.item .edit-toggle:checked ~ .cell label.edit { display: block; }
  form.item .edit-toggle:checked ~ .cell button.edit,
  form.item .edit-toggle:checked ~ .cell a.edit { display: inline-block; }
  form.item .field-name {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  form.item .view { display: block; }
  form.item strong.view, form.item span.view { padding: 0.3rem 0.4rem; overflow-wrap: anywhere; }
  form.item .view-name { display: none; }
  form.item input:not(.edit-toggle) { margin: 0; padding: 0.3rem 0.4rem; border-radius: 6px; }
  form.item .phrase strong.view { font-weight: 700; }
  form.item .words { padding: 0 0.4rem; margin-top: 0.1rem; color: var(--color-text-muted); font-size: 0.8rem; overflow-wrap: anywhere; }
  form.item .actions { display: flex; flex-wrap: wrap; gap: 0.4rem; padding-top: 0.1rem; }
  form.item button, form.item .button-label, form.item .button-link {
    display: inline-block;
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 600;
    line-height: normal;
    text-decoration: none;
    color: #fff;
    background: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: 6px;
    cursor: pointer;
  }
  form.item button:hover { background: var(--color-accent-hover); }
  form.item .button-label, form.item .button-link, form.item button.secondary {
    color: var(--color-text);
    background: transparent;
    border-color: var(--color-border);
  }
  form.item .button-label:hover, form.item .button-link:hover, form.item button.secondary:hover {
    background: var(--color-bg);
  }
  form.item button.danger { color: var(--color-danger); background: transparent; border-color: var(--color-danger); }
  form.item button.danger:hover { background: var(--color-bg); }
  form.item .edit-toggle:focus-visible ~ .actions .button-label,
  form.item button:focus-visible,
  form.item .button-link:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  @media (max-width: 30rem) {
    body { margin: 1.25rem auto; }
    section + section { margin-top: 1.5rem; padding-top: 1.5rem; }
    .item-head { display: none; }
    form.item { display: flex; flex-direction: column; align-items: stretch; gap: 0.4rem; padding: 0.9rem 0; }
    form.item .field-name {
      position: static;
      width: auto;
      height: auto;
      clip-path: none;
      display: block;
      margin-bottom: 0.2rem;
      font-size: 0.75rem;
    }
    form.item strong.view, form.item span.view { padding: 0; }
    form.item .view-name { display: inline; margin-right: 0.4rem; color: var(--color-text-muted); font-size: 0.8rem; }
    form.item .words { padding: 0; }
    form.item .edit-toggle:checked ~ .cell { margin-bottom: 0.4rem; }
    form.item .qty input { width: 6rem; }
    form.item .actions { padding-top: 0.3rem; }
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
  .household .hint { margin-bottom: 0.85rem; }
  .household .members { margin: 0 0 1rem; padding-left: 1.1rem; font-size: 0.9rem; }
  .household .members li + li { margin-top: 0.25rem; }
  .household code {
    padding: 0.2rem 0.4rem;
    font-size: 0.8rem;
    word-break: break-all;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }
  .household .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.25rem; }
  .household label { margin-bottom: 0.6rem; }
  .household form + form .actions { margin-bottom: 0.85rem; }
  .household form + form .hint { margin-bottom: 0; }
  button.secondary { color: var(--color-link); background: var(--color-surface); border: 1px solid var(--color-border); }
  button.secondary:hover { background: var(--color-bg); }
  button.danger { color: var(--color-danger); }
  .error { color: var(--color-danger); margin: 0 0 1rem; font-size: 0.9rem; }
  .notice { color: var(--color-text); margin: 0 0 1rem; font-size: 0.9rem; }
  .hint { color: var(--color-text-muted); font-size: 0.85rem; margin: 0 0 1rem; }
  .top-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-bottom: 1.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }
  .top-bar ul { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; margin: 0; padding: 0; list-style: none; }
  .top-bar a {
    display: inline-block;
    padding: 0.3rem 0;
    font-size: 0.9rem;
    color: var(--color-text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
  }
  .top-bar a:hover { color: var(--color-text); }
  .top-bar a[aria-current='page'] { color: var(--color-link); font-weight: 600; border-bottom-color: var(--color-accent); }
  .top-bar a:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
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
