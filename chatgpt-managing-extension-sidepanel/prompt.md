# Prompt: Build a Chrome MV3 Side Panel extension to bulk-manage ChatGPT chats/projects (chatgpt.com)

You are an expert Chrome Extension engineer. Build a **Manifest V3** Chrome extension that adds a **Side Panel UI** for **chatgpt.com** to list chats and projects, filter/sort/select them, and perform **bulk archive/delete** operations via ChatGPT’s authenticated backend API. The extension must be robust, stoppable, and rate-limited.

**Important:** Before generating code, you MUST ask the user to verify/collect a few required details (selectors/endpoints/flags). Use sensible defaults when possible. After user answers, output **full source files** ready to “Load unpacked”.

---

## 0) Constraints (must follow)

- Target domain: **https://chatgpt.com/** (not chat.openai.com).
- Chrome extension: **Manifest Version 3**.
- UI must be a **Side Panel** (persistent, not auto-closing).
- No external servers. Everything runs locally in the extension.
- Do not require the user to paste auth tokens.
- Use **rate-limiting** (delay between operations) and a **Stop** button.
- Bulk actions must continue per-item even if some items fail.
- Avoid brittle assumptions; log what’s happening and handle missing data gracefully.

---

## 1) Ask the user to provide/confirm these details (with examples + defaults)

### A) Chrome + OS basics (for side panel compatibility)
1) What Chrome version? (Example: `Chrome 122+` recommended.)
2) Confirm the extension is only used in Chromium-based browsers that support the Side Panel API.

### B) Chat list scraping (DOM)
Ask the user to confirm, using Inspect on chatgpt.com sidebar:
1) Do chat links look like:
   - Example: `<a href="/c/6984a52c-06f0-8332-9858-f12e1c3d28aa">Title</a>`
2) Where is the scrollable container for the chat list? Provide a selector if possible.
   - Example candidates: `[data-testid="sidebar"]`, `nav`, `aside`, or a div with `overflow: auto`.
3) Are chat titles available in text nodes, or do we need an attribute like `aria-label`?

**Default approach if unknown:** query for `a[href^="/c/"]` and derive chatId by stripping `/c/`.

### C) Chat dates (optional)
Ask:
- Do you need dates for “My Chats”, and are they visible in the DOM?
- If not visible, accept “blank” (do NOT invent).
**Default:** show dates only for project chats (from API `update_time`), and leave “My Chats” date blank.

### D) Backend API actions (verify exact payload keys)
Ask user to confirm with DevTools → Network:
1) Conversation mutate endpoint:
   - `PATCH https://chatgpt.com/backend-api/conversation/<chatId>`
2) Archive payload:
   - default: `{"is_archived": true}`
3) Undo archive payload:
   - default: `{"is_archived": false}`
4) Delete payload:
   - default: `{"is_visible": false}`
5) Confirm there is **NO undo for delete** (by design in UI).

If user copied payload from console without quotes, remind them that JS objects show without quotes; JSON must be stringified.

### E) Projects list and project chats API
Ask user to confirm:
1) How to scrape projects list from sidebar:
   - Provide screenshot or DOM hints.
2) Project chats endpoint:
   - `GET https://chatgpt.com/backend-api/gizmos/<gizmoId>/conversations?cursor=0`
3) Confirm gizmoId format:
   - Example: `g-p-697f53b6281c8191a4815678ec395246`
   - IMPORTANT: API uses the short gizmoId (no “-dailyemails” slug).
4) Pagination:
   - Response includes `cursor` (string or null).
   - Items in `items[]` with `id`, `title`, `update_time`.

**Default behavior:** fetch pages until `cursor == null` or Stop is pressed.

### F) Rate limits + defaults
Ask user to confirm default values:
- Delay between operations (default **1200ms**)
- Delay for “Load all” scroll step (default **1200ms**)
- Sort default: **Natural Asc**
- Projects collapsed by default: **true**
- My Chats expanded by default: **true**

### G) Side panel opening behavior (important)
Explain that `chrome.sidePanel.open()` must be called **synchronously** in response to a user gesture.
Ask user preference:
1) Open side panel when clicking extension icon (recommended)
2) Also add a menu/button inside the side panel to re-open/focus it (optional)
**Default:** open on extension icon click.

---

## 2) Required UI + behavior (implement exactly)

### A) Side panel layout
- Top toolbar fixed (sticky):
  - Brand icon `brand.png` shown at top-left before buttons (32x32 image).
  - Buttons: **Refresh**, **Load all**
  - Filter input: “name contains…”
  - Sort mode: `Natural` / `Alphabetical`
  - Sort direction toggle: ▲ / ▼
- Under top toolbar: a single status line:
  - `Loaded: X (Chats A, Projects B) • Filtered: Y • Selected: Z`
- Middle scroll area:
  - Tree list
- Bottom toolbar fixed:
  - Mode: `Archive` / `Delete`
  - Delay(ms)
  - Buttons: `Select all`, `Select none`, `Run bulk`, `Stop`

### B) Sections
- Collapsible **My Chats**
- Collapsible **My Projects** (collapsed by default)
- My Projects shows project names; each project row has:
  - `open` (open project in current tab)
  - `load chats` (fetch project chats via API, paginated)
  - Expand/collapse arrow to show project chats

### C) Filtering rule (special)
- Global filter applies to My Chats chat titles.
- For projects:
  - If project is collapsed: project row is shown only if project name matches filter.
  - If project is expanded: project row is ALWAYS shown, filter applies ONLY to its conversations.

### D) Actions per chat row
Each chat row shows: checkbox, title, optional date, and actions.
- If not mutated:
  - `open`, `archive`, `delete` (no confirmation)
- After archive:
  - Crossed out + badge “archive” + actions: `open`, `undo`
- After delete:
  - Crossed out + badge “delete” + **no actions** (no undo, no open)

### E) Bulk behavior
- During any long action (bulk archive/delete, load-all, project fetch):
  - Disable/gray out UI except Stop.
  - Stop interrupts cleanly (does not undo completed items).
- After bulk ends (even if stopped):
  - Locally mark each successful item as mutated (cross-out + badge).
  - Reload the active chatgpt.com tab.
  - Make Refresh button visually “suggested” (red outline) after any mutation.

---

## 3) Technical architecture (must implement)

### Files to output
- `manifest.json`
- `sw.js` (service worker)
- `content.js` (sidebar scraping + scroll load-all)
- `sidepanel.html`
- `sidepanel.js`
- `sidepanel.css`
- `brand.png` (assume user provides file; include placeholder reference)

### Service worker responsibilities
- Capture the Authorization Bearer token via `chrome.webRequest.onBeforeSendHeaders`
  - filter: `https://chatgpt.com/backend-api/*`
  - store in `chrome.storage.session`
- Provide message APIs:
  - `API_HAS_BEARER`
  - `API_PATCH_CONVERSATION` (PATCH conversation endpoint with JSON payload)
  - `API_GET_PROJECT_CONVERSATIONS_PAGE` (GET project conversations page)
- Open side panel on click:
  - **DO NOT `await` anything before `chrome.sidePanel.open()`** to avoid:
    “may only be called in response to a user gesture”
  - Example pattern:
    - call `chrome.sidePanel.open()` first (no await)
    - then `chrome.sidePanel.setOptions()` (no await)

### Content script responsibilities
- Scrape My Chats:
  - find all `a[href^="/c/"]`
  - extract chatId from href
  - extract title from element text/aria-label
  - preserve natural order index
- Scrape My Projects:
  - best-effort (ask user for selectors if needed)
- Implement “Load all”:
  - identify sidebar scroll container
  - scroll to bottom, wait delay, repeat until count stabilizes N rounds or Stop pressed
- Implement STOP flag.

### Side panel script responsibilities
- Render UI + tree
- Manage state:
  - selected chats
  - collapsed sections
  - expanded projects
  - loaded project chats cache
  - mutated map (archive/delete)
  - refresh suggested indicator
- Send messages to content script for scraping/scroll
- Send messages to service worker for API calls
- Bulk runner with delay and Stop support.

---

## 4) Output format
After user confirms the required details, output code as:
- One code block per file, labeled with filename.
- Keep files complete and directly runnable.

Also include a short “Install & Test” checklist:
1) Load unpacked in `chrome://extensions`
2) Open `https://chatgpt.com`
3) Click extension icon to open side panel
4) Press Refresh
5) Press Load all
6) Select 1–2 chats → Archive
7) Verify cross-out + undo on archive
8) Verify delete has no undo
9) Verify bulk reloads main tab and refresh suggested turns red

---

## 5) Begin now
Start by asking the user the verification checklist in section 1.
Then (after answers) generate the full files.
