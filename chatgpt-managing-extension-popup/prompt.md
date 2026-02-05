# Prompt: Build a Chrome MV3 extension to bulk-manage ChatGPT chats (popup UI)

You are a software engineer building a **Chrome Extension (Manifest V3)** for **chatgpt.com** to help the user **list, filter, sort, select, and bulk archive/delete** their ChatGPT conversations, plus **list Projects** and fetch their conversations. The extension must work without any external servers: **only DOM scraping + fetch calls to chatgpt.com backend endpoints**.

Your job: **produce the full extension source** (all files) and a short setup guide, but first **ask the user to verify required details** and provide any missing inputs. Use the suggested defaults if the user agrees.

---

## 0) Non-negotiable constraints

- Must be **Manifest V3**.
- Must run on **https://chatgpt.com/** (not chat.openai.com).
- UI must be in the **extension action popup** (no side panel for now).
- It is expected that the popup closes on blur (Chrome behavior); do not try to override that.
- All network calls must be done via the extension (service worker) using the user’s authenticated session.
- Must avoid triggering anti-abuse: **configurable delay** between operations and a **Stop** button.
- Must not require user to paste tokens manually. If Bearer token is needed, capture it via `webRequest` from existing requests.

---

## 1) First: ask the user to verify/answer these

Ask the user to confirm these items. Provide suggested defaults.

### A) Domain & selectors (verify)
1. Confirm the site is `https://chatgpt.com/` and the left sidebar shows the conversation list.
2. Confirm that each conversation in sidebar has a link like: `/c/<conversation_id>`.
3. Confirm whether the sidebar “Projects” are visible and identifiable, and whether they have stable anchors/links we can scrape.
   - If unclear: ask the user to provide a screenshot of the sidebar DOM or the CSS selectors they see in Inspect.

### B) API endpoints & payloads (verify)
Ask user to confirm these endpoints exist in their browser (they already tested in devtools):
- **Archive/Delete conversation**
  - `PATCH https://chatgpt.com/backend-api/conversation/<conversation_id>`
  - Archive payload: `{"is_archived":true}`
  - Delete payload: `{"is_visible":false}`
- **Undo rules**
  - Undo is ONLY allowed for archive:
    - Undo archive: send `{"is_archived":false}` (or equivalent endpoint flag — confirm exact boolean).
  - Delete has no undo (UI stays crossed out, no actions).

### C) Project conversations endpoint (verify)
Ask user to confirm:
- Project chat list page fetch:
  - `GET https://chatgpt.com/backend-api/gizmos/<gizmo_id>/conversations?cursor=0`
  - Response contains: `items[]` with fields including `id`, `title`, `update_time`, and `cursor` for pagination.
- Project list load uses:
  - `GET https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?...&cursor=<opaque-token>`
  - Cursor is opaque; we must pass it as-is to paginate.

### D) Defaults (suggest)
- Default delay: **1200ms**
- Load-all scroll delay: **1200ms**
- Default sorting: **Natural Asc**
- Projects section: **collapsed by default**
- My Chats section: **expanded by default**

If user doesn’t confirm a detail, implement with best-effort + clear fallback logs.

---

## 2) Required behavior (must implement exactly)

### 2.1 UI layout rules
- Popup is bigger than default (use `action.default_popup` + CSS sizing).
- **Top bar fixed** (not scrolled away):
  - Buttons: `Refresh`, `Load all`
  - Filter: text input “name contains…”
  - Sort mode: `Natural` / `Alphabetical`
  - Sort direction toggle button with arrows: `▲` / `▼`
- Under top bar: always show a status line:
  - `Loaded: X (Chats A, Projects B) • Filtered: Y • Selected: Z`
- **Bottom bar fixed**:
  - Mode: `Archive` / `Delete`
  - Delay(ms) number input
  - Buttons: `Select all`, `Select none`, `Run bulk`, `Stop`
- Main middle area is scrollable and shows tree list.

### 2.2 Two collapsible sections
- **My Chats** (collapsible)
  - Shows list of conversations scraped from sidebar
- **My Projects** (collapsible, collapsed by default)
  - Initially lists only project names (scraped)
  - Each project row has `open` and `load chats`

### 2.3 Sorting
Two sort modes (both support asc/desc):
- **Natural**: matches ChatGPT sidebar order (DOM order)
- **Alphabetical**: by title

### 2.4 Filtering
- Filter is **local only** (no server).
- Filtering applies to:
  - **My Chats**: filter chat titles
  - **My Projects** special rule:
    - If a project is **collapsed**, it is shown only if project name matches filter.
    - If a project is **expanded**, it is shown **regardless of filter**, but filter applies to its **conversations** list.

### 2.5 Row actions
Each “My Chat” row:
- Checkbox selection for bulk.
- Title + date on right if available.
- Actions:
  - If not mutated:
    - `open`, `archive`, `delete`
  - If mutated by archive:
    - crossed out + badge `archive` + show `open` + `undo`
  - If mutated by delete:
    - crossed out + badge `delete` + show **no actions**
- No confirmation dialogs.

Project view:
- A project row has `load chats` and `open`.
- When project expanded, render its chats under it.
- Project-level checkbox selects **all chats inside that project** (entire project list, not only filtered).
- Project chats have the same per-chat action rules as My Chats.
- “load chats” uses fetch to backend API and supports pagination via cursor.
- While loading, the project auto-expands so user sees progress.
- When loading ends (success, stop, or error), auto-collapse the project.

### 2.6 Bulk operation behavior
- Bulk operations apply to selected items:
  - For My Chats: selected chats visible under current filter.
  - For Project: selected chats inside that project.
- Bulk respects delay between each PATCH.
- During any run (bulk or load-all scroll or project load):
  - Entire UI is disabled/greyed out except Stop button.
  - Stop cancels gracefully (does not revert completed actions).
- After a bulk run ends (even if stopped):
  - Locally mark completed actions (crossout + badge) for processed items.
  - Reload ChatGPT tab (same as single-line operations).

### 2.7 “Refresh suggested” behavior
- After any successful archive/delete/undo action:
  - Set `Refresh` button style to red/bold (suggest refresh).
- Single-line delete/archive should reload the main tab (My Chats actions do; project actions optional but ok).

---

## 3) How the extension must work technically

### 3.1 Architecture
- **content.js**
  - Scrapes sidebar DOM for:
    - My Chats list: `{id, title, url, naturalIndex, dateLabel?}`
    - Projects list: `{gizmoId, title, url, naturalIndex}`
  - Implements “Load all” by scrolling the sidebar container until stable.
  - Responds to messages from popup with these operations:
    - `LIST_CHATS_AND_PROJECTS`
    - `SCROLL_LOAD_ALL`
    - `STOP`
- **sw.js** (service worker)
  - Captures Authorization Bearer token by listening to outbound `chatgpt.com/backend-api/*` requests using `webRequest`.
  - Provides message handlers:
    - `API_HAS_BEARER`
    - `API_PATCH_CONVERSATION` (PATCH archive/delete/unarchive)
    - `API_GET_PROJECT_CONVERSATIONS_PAGE` (GET gizmo conversations page)
- **popup.html / popup.js / popup.css**
  - Implements UI and logic described above.
  - Does all user-facing rendering and local state:
    - selection sets
    - collapsed state
    - expanded-per-project state
    - mutated state

### 3.2 Required permissions (minimum)
- `activeTab`, `scripting`, `storage`, `webRequest`
- `host_permissions`: `https://chatgpt.com/*`

### 3.3 Safety / robustness
- If bearer token is missing:
  - Show log message: “Bearer not captured yet… open chatgpt.com and trigger any backend-api request.”
- Handle API failures per item; continue bulk.
- Cursor pagination tokens are opaque; do not parse.

---

## 4) Deliverables you must output

After the user confirms the items in section 1 (or you proceed with defaults), output **all files**:

- `manifest.json`
- `sw.js`
- `content.js`
- `popup.html`
- `popup.js`
- `popup.css`

Also output a short “Install & Test” guide:
1. Load unpacked extension
2. Open chatgpt.com
3. Click extension icon
4. Click Refresh
5. Click Load all
6. Select some chats
7. Run bulk archive with delay
8. Confirm crossed-out state and refresh suggestion
9. Try undo on an archived chat

---

## 5) Suggested defaults to apply unless user overrides

- Delay(ms): `1200`
- Load all scroll delay: `1200`
- Sort: Natural Asc
- Projects collapsed by default
- My Chats expanded by default
- Project “load chats” starts at cursor `0`
- Project “load chats” stops when response `cursor` is null
- Dates:
  - Use `update_time` from project API for project chats
  - For My Chats: show date only if it can be scraped; otherwise blank (do not invent)

---

## 6) Important: ask the user this exact final verification question

Before generating the code, ask:

> “Please confirm: for Undo archive, should the PATCH payload be `{"is_archived":false}` to the same conversation endpoint?”

If they are unsure, instruct them how to verify in devtools (Network tab) and then proceed using that default.

---

Now begin: ask the verification questions (Section 1) in a concise checklist, then generate full files.
