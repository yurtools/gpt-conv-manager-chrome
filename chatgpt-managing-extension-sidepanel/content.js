// content.js
// - Scrapes chats in sidebar (natural order)
// - Scrapes projects (ONLY links matching /g/g-p-.../project)
//   * Extracts BOTH:
//     - gizmoIdRaw: whatever is in the URL (may include slug suffix, e.g. g-p-<hex>-dailyemails)
//     - gizmoId: canonical gizmo id required by backend API (g-p-<32hex>)
// - Load-all scroll (stoppable)
// - STOP stops scroll loop

let stopFlag = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }

function uniqIdFromUrl(url) {
    try {
        const u = new URL(url, location.origin);
        const parts = u.pathname.split("/").filter(Boolean);
        return parts[parts.length - 1] || url;
    } catch { return url; }
}

// === Chats
function getChatAnchorsInSidebarNaturalOrder() {
    return Array.from(document.querySelectorAll('a[href^="/c/"], a[href^="/chat/"], a[href*="/c/"]'))
    .filter(a => a.offsetParent !== null);
}

function inferDateBucket(anchor) {
    const known = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days"];
    let el = anchor;
    for (let i = 0; i < 12 && el; i++) {
        const parent = el.parentElement;
        if (!parent) break;

        let prev = parent.previousElementSibling;
        for (let j = 0; j < 6 && prev; j++) {
            const t = norm(prev.textContent);
            if (t && known.some(k => t.startsWith(k))) return t;
            prev = prev.previousElementSibling;
        }
        el = parent;
    }
    return "";
}

function listChatsNatural() {
    const anchors = getChatAnchorsInSidebarNaturalOrder();
    const seen = new Set();
    const chats = [];
    let idx = 0;

    for (const a of anchors) {
        const href = a.getAttribute("href");
        if (!href) continue;

        const url = new URL(href, location.origin).toString();
        const id = uniqIdFromUrl(url);
        const key = id || url;
        if (seen.has(key)) continue;
        seen.add(key);

        const title = norm(a.textContent) || norm(a.getAttribute("aria-label")) || "";
        const dateLabel = inferDateBucket(a);

        chats.push({ id, url, title, dateLabel, naturalIndex: idx++ });
    }

    return chats;
}

// === Projects (exact match + canonicalize gizmo id)
//
// Sidebar link example:
//   /g/g-p-697f53b6281c8191a4815678ec395246-dailyemails/project
//
// backend API requires canonical gizmo id:
//   g-p-697f53b6281c8191a4815678ec395246
//
// We therefore parse:
//   gizmoIdRaw = "g-p-697f...-dailyemails"
//   gizmoId    = "g-p-697f..."  (g-p- + 32 hex chars)

function parseProjectFromHref(href) {
    // Accept: /g/<something>/project or /g/<something>/project/
    const m = href.match(/^\/g\/([^\/]+)\/project\/?$/);
    if (!m) return null;

    const gizmoIdRaw = m[1]; // could be g-p-<hex>-slug
    // Canonical: g-p- + 32 hex chars
    const m2 = gizmoIdRaw.match(/^(g-p-[0-9a-fA-F]{32})/);
    const gizmoId = m2 ? m2[1] : null;

    return { gizmoIdRaw, gizmoId };
}

function listProjectsFromSidebar() {
    const projects = [];
    const seen = new Set();

    const links = Array.from(document.querySelectorAll('a[href^="/g/"]'))
    .filter(a => a.offsetParent !== null);

    let idx = 0;
    for (const a of links) {
        const href = a.getAttribute("href") || "";
        const parsed = parseProjectFromHref(href);
        if (!parsed?.gizmoId) continue;

        const title = norm(a.textContent) || "(untitled project)";
        const url = new URL(href, location.origin).toString();

        // De-dupe by canonical gizmo id (not raw slug)
        if (seen.has(parsed.gizmoId)) continue;
        seen.add(parsed.gizmoId);

        projects.push({
            title,
            url,                 // keep full slug URL for open()
        gizmoId: parsed.gizmoId,       // canonical for backend API
        gizmoIdRaw: parsed.gizmoIdRaw, // optional/debug
        naturalIndex: idx++
        });
    }

    return projects;
}

// === Load-all scroll
function findSidebarScrollContainer() {
    const chatLink = document.querySelector('a[href^="/c/"], a[href^="/chat/"], a[href*="/c/"]');
    if (!chatLink) return null;

    let el = chatLink.parentElement;
    for (let i = 0; i < 24 && el; i++) {
        const style = getComputedStyle(el);
        const overflowY = style.overflowY;
        const canScroll =
        (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight;

        if (canScroll) return el;
        el = el.parentElement;
    }

    const candidates = Array.from(document.querySelectorAll("nav, aside, div"))
    .filter(x => x.offsetParent !== null && x.scrollHeight > x.clientHeight);
    return candidates[0] || null;
}

async function scrollSidebarToLoadAll({ pauseMs = 450, maxRounds = 120, stableRounds = 6 } = {}) {
    stopFlag = false;

    const scroller = findSidebarScrollContainer();
    if (!scroller) return { ok: false, error: "No sidebar scroll container found" };

    let lastCount = 0;
    let stable = 0;

    for (let round = 0; round < maxRounds; round++) {
        if (stopFlag) return { ok: true, rounds: round, finalCount: lastCount, stopped: true };

        const count = document.querySelectorAll('a[href^="/c/"], a[href^="/chat/"], a[href*="/c/"]').length;

        if (count === lastCount) stable++;
        else stable = 0;

        lastCount = count;

        if (stable >= stableRounds) {
            return { ok: true, rounds: round + 1, finalCount: count };
        }

        scroller.scrollTop = scroller.scrollHeight;
        await sleep(pauseMs);
    }

    const finalCount = document.querySelectorAll('a[href^="/c/"], a[href^="/chat/"], a[href*="/c/"]').length;
    return { ok: true, rounds: maxRounds, finalCount, note: "Reached maxRounds" };
}

// === Messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        try {
            if (msg?.type === "LIST_CHATS_AND_PROJECTS") {
                const chats = listChatsNatural();
                const projects = listProjectsFromSidebar();
                sendResponse({ ok: true, data: { chats, projects } });
                return;
            }

            if (msg?.type === "SCROLL_LOAD_ALL") {
                const delayMs = Math.max(250, Number(msg.delayMs || 450));
                const res = await scrollSidebarToLoadAll({ pauseMs: delayMs });
                sendResponse(res);
                return;
            }

            if (msg?.type === "STOP") {
                stopFlag = true;
                sendResponse({ ok: true });
                return;
            }

            sendResponse({ ok: false, error: "Unknown message type" });
        } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
        }
    })();

    return true;
});
