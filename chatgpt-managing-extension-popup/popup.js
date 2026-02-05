// popup.js
//
// Change requested:
// - In "My Projects": if a project is expanded, the global filter applies ONLY to that project's conversations,
//   but the project row itself is always shown (even if project name doesn't match filter).
// - For collapsed projects, filter still applies to project name (so you can search projects by name).
//
// Undo behavior:
// - Undo ONLY for archive.
// - Delete stays crossed out and shows NO actions.
//
// Bulk still reloads the main ChatGPT tab at the end.

const treeEl = document.getElementById("tree");
const statusEl = document.getElementById("status");
const meta2El = document.getElementById("meta2");

const btnRefresh = document.getElementById("btnRefresh");
const btnLoadAll = document.getElementById("btnLoadAll");
const btnSelectAll = document.getElementById("btnSelectAll");
const btnSelectNone = document.getElementById("btnSelectNone");
const btnRun = document.getElementById("btnRun");
const btnStop = document.getElementById("btnStop");

const filterTextEl = document.getElementById("filterText");
const sortModeEl = document.getElementById("sortMode");
const btnDirEl = document.getElementById("btnDir");

const modeEl = document.getElementById("mode");
const delayMsEl = document.getElementById("delayMs");

const topwrap = document.getElementById("topwrap");
const main = document.getElementById("main");
const bottombar = document.getElementById("bottombar");

let state = {
    data: null,
    selected: new Set(),
    filter: "",
    sortMode: "natural",
    sortDir: "asc",
    collapsed: { myChats: false, myProjects: true },
    running: false,
    stopRequested: false,

    // chatId -> { lastAction: "archive"|"delete", ts }
    mutated: new Map(),

    // gizmoId -> { loading, items, cursor, loadedAt, selectedIds:Set }
    projectChats: new Map(),

    // gizmoId -> boolean
    projectExpanded: new Map(),

    refreshSuggested: false
};

function log(line) {
    statusEl.textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + statusEl.textContent;
}

function setRunning(running) {
    state.running = running;
    if (running) {
        topwrap.classList.add("disabled");
        main.classList.add("disabled");
        bottombar.classList.add("disabled");
        btnStop.style.pointerEvents = "auto";
        btnStop.style.opacity = "1";
    } else {
        topwrap.classList.remove("disabled");
        main.classList.remove("disabled");
        bottombar.classList.remove("disabled");
        btnStop.style.pointerEvents = "";
        btnStop.style.opacity = "";
    }
}

function normalize(s) { return (s || "").toLowerCase().trim(); }
function matchesFilter(title) {
    const f = normalize(state.filter);
    if (!f) return true;
    return normalize(title).includes(f);
}

function sortByModeNaturalOrAlpha(arr) {
    let out = [...arr];
    if (state.sortMode === "alpha") out.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    else out.sort((a, b) => (a.naturalIndex ?? 0) - (b.naturalIndex ?? 0));
    if (state.sortDir === "desc") out.reverse();
    return out;
}

function getDelayMs() { return Math.max(250, Number(delayMsEl.value || 1200)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getChatGPTTabId() {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.url?.startsWith("https://chatgpt.com/")) return active.id;
        return tabs?.[0]?.id;
}

async function reloadChatGPTTab() {
    const tabId = await getChatGPTTabId();
    if (!tabId) return;
    await chrome.tabs.reload(tabId);
}

async function sendToContent(msg) {
    const tabId = await getChatGPTTabId();
    if (!tabId) throw new Error("Open a https://chatgpt.com tab first.");

        try {
            return await chrome.tabs.sendMessage(tabId, msg);
        } catch (e) {
            const m = String(e?.message || e);
            if (!m.toLowerCase().includes("receiving end does not exist")) throw e;
            await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
            return await chrome.tabs.sendMessage(tabId, msg);
        }
}

async function apiHasBearer() {
    return await chrome.runtime.sendMessage({ type: "API_HAS_BEARER" });
}
async function apiPatch(chatId, action) {
    return await chrome.runtime.sendMessage({ type: "API_PATCH_CONVERSATION", chatId, action });
}
async function apiGetProjectPage(gizmoId, cursor) {
    return await chrome.runtime.sendMessage({ type: "API_GET_PROJECT_CONVERSATIONS_PAGE", gizmoId, cursor });
}

function setRefreshSuggested(on) {
    state.refreshSuggested = on;
    if (on) btnRefresh.classList.add("suggest");
    else btnRefresh.classList.remove("suggest");
}

function markMutated(chatId, action) {
    if (action !== "archive" && action !== "delete") return;
    state.mutated.set(chatId, { lastAction: action, ts: Date.now() });
    setRefreshSuggested(true);
}

function clearMutated(chatId) {
    state.mutated.delete(chatId);
    setRefreshSuggested(true);
}

function mutationFor(chatId) {
    return state.mutated.get(chatId) || null;
}

function isProjectExpanded(gizmoId) {
    return !!state.projectExpanded.get(gizmoId);
}
function setProjectExpanded(gizmoId, expanded) {
    state.projectExpanded.set(gizmoId, !!expanded);
}

function computeVisibleProjects(allProjects) {
    // If filter matches project title => show.
    // If project is expanded => show regardless of title match.
    // If collapsed and doesn't match => hide.
    const visible = [];
    for (const p of allProjects || []) {
        const expanded = isProjectExpanded(p.gizmoId);
        if (expanded || matchesFilter(p.title)) visible.push(p);
    }
    return visible;
}

function updateMeta() {
    if (!state.data) {
        meta2El.textContent = "Loaded: 0 • Filtered: 0 • Selected: 0";
        return;
    }

    const loadedChats = state.data.chats?.length || 0;
    const loadedProjects = state.data.projects?.length || 0;

    const filteredChats = (state.data.chats || []).filter(c => matchesFilter(c.title)).length;

    const visibleProjects = computeVisibleProjects(state.data.projects || []);
    const filteredProjects = visibleProjects.length;

    meta2El.textContent =
    `Loaded: ${loadedChats + loadedProjects} (Chats ${loadedChats}, Projects ${loadedProjects}) • Filtered: ${filteredChats + filteredProjects} • Selected: ${state.selected.size}`;
}

function render() {
    treeEl.innerHTML = "";
    updateMeta();
    if (!state.data) return;

    const chatsFiltered = (state.data.chats || []).filter(c => matchesFilter(c.title));

    // IMPORTANT: projects visibility uses special rule: expanded stays visible regardless of title filter
    const projectsVisible = computeVisibleProjects(state.data.projects || []);

    function makeSection(titleText, collapsedKey, bodyBuilder) {
        const sec = document.createElement("div");
        sec.className = "section";

        const hdr = document.createElement("div");
        hdr.className = "hdr";

        const toggle = document.createElement("button");
        toggle.textContent = state.collapsed[collapsedKey] ? "▸" : "▾";
        toggle.style.padding = "2px 10px";
        toggle.onclick = () => {
            state.collapsed[collapsedKey] = !state.collapsed[collapsedKey];
            render();
        };

        const label = document.createElement("div");
        label.textContent = titleText;

        hdr.append(toggle, label);
        sec.appendChild(hdr);

        if (!state.collapsed[collapsedKey]) {
            const items = document.createElement("div");
            items.className = "items";
            bodyBuilder(items);
            sec.appendChild(items);
        }

        return sec;
    }

    // ===== Projects =====
    treeEl.appendChild(makeSection("My Projects", "myProjects", (items) => {
        if (projectsVisible.length === 0) {
            const empty = document.createElement("div");
            empty.style.color = "#666";
            empty.textContent = "(no projects matched filter)";
            items.appendChild(empty);
            return;
        }

        const sorted = sortByModeNaturalOrAlpha(projectsVisible);

        for (const p of sorted) {
            const cache = state.projectChats.get(p.gizmoId);
            const loadedCount = cache?.items?.length || 0;
            const loading = !!cache?.loading;
            const expanded = isProjectExpanded(p.gizmoId);

            const row = document.createElement("div");
            row.className = "row";

            const expBtn = document.createElement("button");
            expBtn.textContent = expanded ? "▾" : "▸";
            expBtn.style.padding = "2px 10px";
            expBtn.title = expanded ? "Collapse" : "Expand";
            expBtn.onclick = () => {
                setProjectExpanded(p.gizmoId, !expanded);
                render();
            };

            const name = document.createElement("div");
            name.className = "title";
            name.textContent = p.title || "(untitled project)";

            const status = document.createElement("span");
            status.className = "mutBadge";
            if (loading) status.textContent = `loading… (${loadedCount})`;
            else if (loadedCount > 0) status.textContent = `loaded: ${loadedCount}`;
            else status.textContent = "";

            const load = document.createElement("a");
            load.href = "#";
            load.textContent = "load chats";
            load.onclick = async (e) => {
                e.preventDefault();
                await loadProjectChats(p.gizmoId);
            };

            const open = document.createElement("a");
            open.href = "#";
            open.textContent = "open";
            open.onclick = async (e) => {
                e.preventDefault();
                const tabId = await getChatGPTTabId();
                if (tabId && p.url) chrome.tabs.update(tabId, { url: p.url });
            };

            row.append(expBtn, name);
            if (status.textContent) row.append(status);
            row.append(load, open);
            items.appendChild(row);

            if (!expanded) continue;

            // If expanded: filter applies ONLY to its conversations (not the project row)
            const projectItemsAll = cache?.items || [];
            const projectItemsFiltered = projectItemsAll.filter(c => matchesFilter(c.title));

            if (loading && loadedCount === 0) {
                const loadingRow = document.createElement("div");
                loadingRow.style.color = "#666";
                loadingRow.textContent = "Loading project chats…";
                items.appendChild(loadingRow);
                continue;
            }

            if (cache && projectItemsAll.length > 0) {
                if (!cache.selectedIds) cache.selectedIds = new Set();

                // Keep selection set consistent: if filter hides an item, it remains selected but not visible (OK).
                const sub = document.createElement("div");
                sub.className = "items";

                const projSelectRow = document.createElement("div");
                projSelectRow.className = "row";

                const projChk = document.createElement("input");
                projChk.type = "checkbox";

                // Checkbox behavior: select/deselect ALL chats in this project (not only filtered)
                const total = projectItemsAll.length;
                const selCount = cache.selectedIds.size;
                projChk.checked = (selCount > 0 && selCount === total);
                projChk.indeterminate = (selCount > 0 && selCount < total);
                projChk.onchange = () => {
                    cache.selectedIds.clear();
                    if (projChk.checked) for (const it of projectItemsAll) cache.selectedIds.add(it.id);
                    render();
                };

                const projInfo = document.createElement("div");
                projInfo.className = "title";
                projInfo.textContent =
                `Project chats: ${total} (visible ${projectItemsFiltered.length}) (selected ${cache.selectedIds.size})`;

                const projRun = document.createElement("a");
                projRun.href = "#";
                projRun.textContent = "run bulk (project)";
                projRun.onclick = async (e) => {
                    e.preventDefault();
                    await runBulkApiActionOnList(
                        projectItemsAll.filter(it => cache.selectedIds.has(it.id)),
                                                 modeEl.value,
                                                 getDelayMs()
                    );
                };

                projSelectRow.append(projChk, projInfo, projRun);
                sub.appendChild(projSelectRow);

                if (projectItemsFiltered.length === 0) {
                    const noMatch = document.createElement("div");
                    noMatch.style.color = "#666";
                    noMatch.textContent = "(no conversations matched filter in this project)";
                    sub.appendChild(noMatch);
                } else {
                    for (const c of projectItemsFiltered) {
                        const m = mutationFor(c.id);
                        const isMut = !!m;

                        const r = document.createElement("div");
                        r.className = "row" + (isMut ? " mutated" : "");

                        const chk = document.createElement("input");
                        chk.type = "checkbox";
                        chk.checked = cache.selectedIds.has(c.id);
                        chk.onchange = () => {
                            if (chk.checked) cache.selectedIds.add(c.id);
                            else cache.selectedIds.delete(c.id);
                            render();
                        };

                        const title = document.createElement("div");
                        title.className = "title";
                        title.textContent = c.title || "(untitled)";

                        const date = document.createElement("div");
                        date.className = "date";
                        date.textContent = c.updateLabel || "";

                        if (isMut) {
                            const badge = document.createElement("span");
                            badge.className = "mutBadge";
                            badge.textContent = m.lastAction;

                            // Undo only for archive; delete => NO actions available
                            if (m.lastAction === "archive") {
                                const openChat = document.createElement("a");
                                openChat.href = "#";
                                openChat.textContent = "open";
                                openChat.onclick = async (e) => {
                                    e.preventDefault();
                                    const tabId = await getChatGPTTabId();
                                    if (tabId) chrome.tabs.update(tabId, { url: c.url });
                                };

                                const undo = document.createElement("a");
                                undo.href = "#";
                                undo.textContent = "undo";
                                undo.onclick = async (e) => {
                                    e.preventDefault();
                                    await runSingleArchiveUndo(c.id);
                                };

                                r.append(chk, title, date, badge, openChat, undo);
                            } else {
                                r.append(chk, title, date, badge);
                            }
                        } else {
                            const openChat = document.createElement("a");
                            openChat.href = "#";
                            openChat.textContent = "open";
                            openChat.onclick = async (e) => {
                                e.preventDefault();
                                const tabId = await getChatGPTTabId();
                                if (tabId) chrome.tabs.update(tabId, { url: c.url });
                            };

                            const archive = document.createElement("a");
                            archive.href = "#";
                            archive.textContent = "archive";
                            archive.onclick = async (e) => {
                                e.preventDefault();
                                await runSingleApiAction("archive", c.id, false);
                            };

                            const del = document.createElement("a");
                            del.href = "#";
                            del.textContent = "delete";
                            del.className = "danger";
                            del.onclick = async (e) => {
                                e.preventDefault();
                                await runSingleApiAction("delete", c.id, false);
                            };

                            r.append(chk, title, date, openChat, archive, del);
                        }

                        sub.appendChild(r);
                    }
                }

                items.appendChild(sub);
            }
        }
    }));

    // ===== My Chats =====
    treeEl.appendChild(makeSection("My Chats", "myChats", (items) => {
        if (chatsFiltered.length === 0) {
            const empty = document.createElement("div");
            empty.style.color = "#666";
            empty.textContent = "(no chats matched filter)";
            items.appendChild(empty);
            return;
        }

        const visible = sortByModeNaturalOrAlpha(chatsFiltered);

        for (const c of visible) {
            const m = mutationFor(c.id);
            const isMut = !!m;

            const row = document.createElement("div");
            row.className = "row" + (isMut ? " mutated" : "");

            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = state.selected.has(c.id);
            chk.onchange = () => {
                if (chk.checked) state.selected.add(c.id);
                else state.selected.delete(c.id);
                updateMeta();
            };

            const title = document.createElement("div");
            title.className = "title";
            title.textContent = c.title || "(untitled)";

            const date = document.createElement("div");
            date.className = "date";
            date.textContent = c.dateLabel || "";

            if (isMut) {
                const badge = document.createElement("span");
                badge.className = "mutBadge";
                badge.textContent = m.lastAction;

                // Undo only for archive; delete => NO actions available
                if (m.lastAction === "archive") {
                    const open = document.createElement("a");
                    open.href = "#";
                    open.textContent = "open";
                    open.onclick = async (e) => {
                        e.preventDefault();
                        const tabId = await getChatGPTTabId();
                        if (tabId) chrome.tabs.update(tabId, { url: c.url });
                    };

                    const undo = document.createElement("a");
                    undo.href = "#";
                    undo.textContent = "undo";
                    undo.onclick = async (e) => {
                        e.preventDefault();
                        await runSingleArchiveUndo(c.id);
                    };

                    row.append(chk, title, date, badge, open, undo);
                } else {
                    row.append(chk, title, date, badge);
                }
            } else {
                const open = document.createElement("a");
                open.href = "#";
                open.textContent = "open";
                open.onclick = async (e) => {
                    e.preventDefault();
                    const tabId = await getChatGPTTabId();
                    if (tabId) chrome.tabs.update(tabId, { url: c.url });
                };

                const archive = document.createElement("a");
                archive.href = "#";
                archive.textContent = "archive";
                archive.onclick = async (e) => {
                    e.preventDefault();
                    await runSingleApiAction("archive", c.id, true);
                };

                const del = document.createElement("a");
                del.href = "#";
                del.textContent = "delete";
                del.className = "danger";
                del.onclick = async (e) => {
                    e.preventDefault();
                    await runSingleApiAction("delete", c.id, true);
                };

                row.append(chk, title, date, open, archive, del);
            }

            items.appendChild(row);
        }
    }));
}

async function refreshList() {
    try {
        log("Refreshing…");
        setRefreshSuggested(false);

        const bearerRes = await apiHasBearer().catch(() => null);
        if (!bearerRes?.hasBearer) {
            log("Note: Bearer not captured yet (API actions may fail). Open chatgpt.com and reload/open a chat so it makes backend-api requests.");
        }

        const res = await sendToContent({ type: "LIST_CHATS_AND_PROJECTS" });
        if (!res?.ok) {
            log(`Failed: ${res?.error || "unknown error"}`);
            return;
        }

        state.data = res.data;
        state.selected.clear();

        render();
        log(`Loaded chats=${res.data.chats.length}, projects=${res.data.projects.length}`);
    } catch (e) {
        log(`Error: ${e.message}`);
    }
}

async function loadProjectChats(gizmoId) {
    if (!state.data) return;

    const existing = state.projectChats.get(gizmoId);
    if (existing?.loading) return;

    setProjectExpanded(gizmoId, true);
    state.projectChats.set(gizmoId, { loading: true, items: [], cursor: "0", loadedAt: null, selectedIds: new Set() });
    render();

    setRunning(true);
    state.stopRequested = false;

    try {
        log(`Loading project chats (gizmo=${gizmoId})…`);
        let cursor = "0";
        const all = [];

        while (!state.stopRequested) {
            const page = await apiGetProjectPage(gizmoId, cursor);
            if (!page?.ok) throw new Error(page?.error || "Project API error");

            const data = page.data || {};
            const items = Array.isArray(data.items) ? data.items : [];
            for (const it of items) {
                all.push({
                    id: it.id,
                    title: it.title || "",
                    update_time: it.update_time,
                    updateLabel: it.update_time ? new Date(it.update_time).toLocaleString() : "",
                         url: `https://chatgpt.com/c/${it.id}`
                });
            }

            const cache = state.projectChats.get(gizmoId);
            if (cache) cache.items = all;
            render();

            if (!data.cursor) break;
            cursor = data.cursor;
        }

        const cache = state.projectChats.get(gizmoId);
        if (cache) {
            cache.loading = false;
            cache.cursor = null;
            cache.loadedAt = Date.now();
        }

        log(`Project chats loaded: ${all.length}${state.stopRequested ? " (stopped early)" : ""}`);
    } catch (e) {
        const cache = state.projectChats.get(gizmoId);
        if (cache) cache.loading = false;
        log(`Project chats load FAILED: ${e.message}`);
    } finally {
        setRunning(false);
        setProjectExpanded(gizmoId, false); // auto-collapse after load
        render();
    }
}

async function runSingleApiAction(action, chatId, reloadTab = false) {
    const delayMs = getDelayMs();
    setRunning(true);
    state.stopRequested = false;

    log(`${action.toUpperCase()} (API): ${chatId}…`);

    try {
        const res = await apiPatch(chatId, action);
        if (!res?.ok) throw new Error(res?.error || "API error");

        markMutated(chatId, action);
        log(`${action} OK`);
        await sleep(delayMs);

        if (reloadTab) await reloadChatGPTTab();
    } catch (e) {
        log(`${action} FAILED: ${e.message}`);
    } finally {
        setRunning(false);
        render();
    }
}

// Undo only for archive: archive -> unarchive, then restore row/actions
async function runSingleArchiveUndo(chatId) {
    const m = mutationFor(chatId);
    if (!m || m.lastAction !== "archive") return;

    const delayMs = getDelayMs();
    setRunning(true);
    state.stopRequested = false;

    log(`UNDO ARCHIVE (API): ${chatId} (archive -> unarchive)…`);

    try {
        const res = await apiPatch(chatId, "unarchive");
        if (!res?.ok) throw new Error(res?.error || "API error");

        clearMutated(chatId);
        log(`undo OK`);
        await sleep(delayMs);
    } catch (e) {
        log(`undo FAILED: ${e.message}`);
    } finally {
        setRunning(false);
        render();
    }
}

async function runBulkMyChats() {
    if (!state.data) return;

    const action = modeEl.value; // archive|delete
    const delayMs = getDelayMs();

    const visible = (state.data.chats || []).filter(c => matchesFilter(c.title));
    const selected = visible.filter(c => state.selected.has(c.id)).map(c => ({ id: c.id }));

    if (selected.length === 0) {
        log("No chats selected (within current filter).");
        return;
    }

    await runBulkApiActionOnList(selected, action, delayMs);
}

async function runBulkApiActionOnList(list, actionOverride, delayOverride) {
    const action = actionOverride || modeEl.value;
    const delayMs = delayOverride || getDelayMs();

    if (!list || list.length === 0) {
        log("No items selected for bulk.");
        return;
    }

    setRunning(true);
    state.stopRequested = false;

    log(`Bulk ${action.toUpperCase()} (API) for ${list.length} chats (delay=${delayMs}ms)…`);

    let ok = 0, failed = 0, processed = 0;

    try {
        for (const item of list) {
            if (state.stopRequested) break;
            processed++;

            try {
                const res = await apiPatch(item.id, action);
                if (!res?.ok) throw new Error(res?.error || "API error");
                ok++;
                markMutated(item.id, action);
            } catch (e) {
                failed++;
                log(`${action} FAILED for ${item.id}: ${e.message}`);
            }

            await sleep(delayMs);
        }
    } finally {
        setRunning(false);
        log(`Bulk done. processed=${processed} ok=${ok} failed=${failed} stopped=${state.stopRequested}`);
        render();

        // Reload main page at the end (even if stopped), same as single-line ops.
        if (processed > 0) {
            try {
                await reloadChatGPTTab();
            } catch (e) {
                log(`Tab reload failed: ${e.message}`);
            }
        }
    }
}

async function stopAction() {
    state.stopRequested = true;
    try { await sendToContent({ type: "STOP" }); } catch {}
    log("Stop requested (will stop after current item).");
}

// ===== UI events
btnRefresh.addEventListener("click", refreshList);

btnLoadAll.addEventListener("click", async () => {
    const delayMs = getDelayMs();
    setRunning(true);
    state.stopRequested = false;
    log(`Load all: scrolling sidebar until stable (pause=${delayMs}ms)…`);
    try {
        const res = await sendToContent({ type: "SCROLL_LOAD_ALL", delayMs });
        if (!res?.ok) log(`Load all failed: ${res?.error || "unknown error"}`);
        else log(`Load all done. rounds=${res.rounds} finalCount=${res.finalCount}${res.note ? " (" + res.note + ")" : ""}`);
    } catch (e) {
        log(`Load all error: ${e.message}`);
    } finally {
        setRunning(false);
        await refreshList();
    }
});

btnSelectAll.addEventListener("click", () => {
    if (!state.data) return;
    const visibleChats = (state.data.chats || []).filter(c => matchesFilter(c.title));
    for (const c of visibleChats) state.selected.add(c.id);
    render();
});
btnSelectNone.addEventListener("click", () => {
    state.selected.clear();
    render();
});

btnRun.addEventListener("click", runBulkMyChats);
btnStop.addEventListener("click", stopAction);

filterTextEl.addEventListener("input", () => {
    state.filter = filterTextEl.value || "";
    render();
});
sortModeEl.addEventListener("change", () => {
    state.sortMode = sortModeEl.value;
    render();
});
btnDirEl.addEventListener("click", () => {
    state.sortDir = (state.sortDir === "asc") ? "desc" : "asc";
    btnDirEl.textContent = (state.sortDir === "asc") ? "▲" : "▼";
    render();
});

// init
render();
refreshList();
