// sw.js
//
// Captures Bearer from real backend-api requests.
//
// API operations used:
//
// 1) Conversation mutate:
//   PATCH https://chatgpt.com/backend-api/conversation/<chatId>
//   - archive    -> { is_archived: true }
//   - unarchive  -> { is_archived: false }
//   - delete     -> { is_visible: false }
//   - undelete   -> { is_visible: true }
//
// 2) Project (gizmo) conversations list:
//   GET https://chatgpt.com/backend-api/gizmos/<gizmo_id>/conversations?cursor=<cursor>
//
// Side panel:
// - Open sidepanel.html on toolbar icon click

let bearer = null;

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const headers = details.requestHeaders || [];
        for (const h of headers) {
            if (h?.name?.toLowerCase() === "authorization" && typeof h.value === "string") {
                if (h.value.startsWith("Bearer ")) {
                    bearer = h.value;
                    chrome.storage.session.set({ chatgpt_bearer: bearer });
                    break;
                }
            }
        }
    },
    { urls: ["https://chatgpt.com/backend-api/*"] },
    ["requestHeaders"]
);

async function getBearer() {
    if (bearer) return bearer;
    const v = await chrome.storage.session.get(["chatgpt_bearer"]);
    bearer = v.chatgpt_bearer || null;
    return bearer;
}

function requireBearerOrThrow(token) {
    if (!token) {
        throw new Error(
            "Bearer not captured yet. Open https://chatgpt.com, reload/open a chat so it makes backend-api requests, then try again."
        );
    }
}

function actionToPayload(action) {
    switch (action) {
        case "archive": return { is_archived: true };
        case "unarchive": return { is_archived: false };
        case "delete": return { is_visible: false };
        case "undelete": return { is_visible: true };
        default: throw new Error(`Unknown action: ${action}`);
    }
}

async function patchConversation(chatId, action) {
    const token = await getBearer();
    requireBearerOrThrow(token);

    const url = `https://chatgpt.com/backend-api/conversation/${chatId}`;
    const payloadObj = actionToPayload(action);

    const resp = await fetch(url, {
        method: "PATCH",
        headers: {
            "Authorization": token,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payloadObj)
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }
    return true;
}

async function fetchProjectConversationsPage(gizmoId, cursor) {
    const token = await getBearer();
    requireBearerOrThrow(token);

    const c = (cursor === null || cursor === undefined) ? "0" : String(cursor);
    const url =
    `https://chatgpt.com/backend-api/gizmos/${encodeURIComponent(gizmoId)}` +
    `/conversations?cursor=${encodeURIComponent(c)}`;

    const resp = await fetch(url, {
        method: "GET",
        headers: { "Authorization": token }
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }

    return await resp.json();
}

// Open side panel on icon click
// Open side panel on icon click (must be immediate; no await before open)
chrome.action.onClicked.addListener((tab) => {
    if (!tab?.id) return;

    // 1) OPEN FIRST (gesture-safe)
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});

    // 2) Configure options AFTER (doesn't need to be gesture-bound)
    chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: "sidepanel.html",
        enabled: true
    }).catch(() => {});
});


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        try {
            if (msg?.type === "API_HAS_BEARER") {
                const token = await getBearer();
                sendResponse({ ok: true, hasBearer: !!token });
                return;
            }

            if (msg?.type === "API_PATCH_CONVERSATION") {
                const { chatId, action } = msg;
                if (!chatId) throw new Error("Missing chatId");
                await patchConversation(chatId, action);
                sendResponse({ ok: true });
                return;
            }

            if (msg?.type === "API_GET_PROJECT_CONVERSATIONS_PAGE") {
                const { gizmoId, cursor } = msg;
                if (!gizmoId) throw new Error("Missing gizmoId");
                const json = await fetchProjectConversationsPage(gizmoId, cursor);
                sendResponse({ ok: true, data: json });
                return;
            }

            sendResponse({ ok: false, error: "Unknown message type" });
        } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
        }
    })();

    return true;
});
