"use strict";

// Accounts/Connections — one GET /api/accounts call covers every
// integration (OAuth-capable and config-only alike); OAuth connect is a
// plain link navigation (not fetch — the browser needs to actually follow
// the redirect to the provider), disconnect is a real POST.

state.accounts = { items: [], loaded: false, loading: false, error: null, search: "", filter: "all" };

const DEFAULT_ACCOUNTS_PREVIEW = [
  { key: "gmail", label: "Gmail", connected: true, connectUrl: "/auth/gmail" },
  { key: "slack", label: "Slack (workspace bot)", connected: true, connectUrl: "/auth/slack" },
  { key: "github", label: "GitHub (repos & actions)", connected: true, connectUrl: "/auth/github" },
  { key: "twitter", label: "X / Twitter", connected: true, connectUrl: "/auth/twitter" },
  { key: "linkedin", label: "LinkedIn", connected: false, connectUrl: "/auth/linkedin" },
  { key: "notion", label: "Notion (workspace docs)", connected: false, connectUrl: "/auth/notion" },
  { key: "stripe", label: "Stripe (billing & metrics)", connected: false, configOnly: true, configHint: "Configured via Stripe API key in Settings." },
  { key: "zernio", label: "Zernio (social & messaging)", connected: false, configOnly: true, configHint: "Configured via Zernio API key in Settings.", signupUrl: "https://zernio.com" },
  { key: "postiz", label: "Postiz (social scheduling)", connected: false, configOnly: true, configHint: "Configured via Postiz API key in Settings." },
];

async function loadAccounts(force) {
  if (state.accounts.loaded && !force) return;
  state.accounts.loading = true;
  render();
  try {
    state.accounts.items = await fetchJSON("/api/accounts");
    state.accounts.loaded = true;
    state.accounts.error = null;
  } catch (err) {
    if (String(err).includes("Not signed in") || String(err).includes("401")) {
      state.accounts.items = DEFAULT_ACCOUNTS_PREVIEW;
      state.accounts.loaded = true;
      state.accounts.error = null;
    } else {
      state.accounts.error = err instanceof Error ? err.message : String(err);
    }
  }
  state.accounts.loading = false;
  render();
}
// Connected systems (remote MCP servers — the ERPs): a separate list from the
// integrations above, because each is added by the user (name + URL + key)
// rather than being a fixed integration this app ships with.
state.remoteMcp = { items: [], loaded: false, loading: false, error: null };

async function loadRemoteMcp(force) {
  if (state.remoteMcp.loaded && !force) return;
  state.remoteMcp.loading = true;
  try {
    state.remoteMcp.items = await fetchJSON("/api/remote-mcp");
    state.remoteMcp.error = null;
  } catch (err) {
    // The static preview (no sign-in) has no such endpoint — show an empty list rather than an error.
    const text = String(err);
    state.remoteMcp.items = [];
    state.remoteMcp.error = text.includes("Not signed in") || text.includes("401") ? null : err instanceof Error ? err.message : text;
  }
  state.remoteMcp.loaded = true;
  state.remoteMcp.loading = false;
  render();
}

LAZY_LOADERS.accounts = () => {
  loadAccounts(false);
  loadRemoteMcp(false);
};

const REMOTE_MCP_AGENT_OPTIONS = [
  ["analysis", "Analysis"],
  ["finance", "Finance"],
  ["crm", "CRM"],
  ["sales", "Sales"],
];

function renderRemoteMcpSection() {
  const { items, loaded, error } = state.remoteMcp;
  const rows = items
    .map((c) => {
      const statusClass = c.status === "ok" ? "success" : c.status === "error" ? "error" : "running";
      const statusLabel = c.status === "ok" ? "Connected" : c.status === "error" ? "Unreachable" : "Checking…";
      let host = c.url;
      try {
        host = new URL(c.url).host;
      } catch {
        // keep the raw url
      }
      const detail =
        c.status === "error"
          ? c.error || "Could not connect."
          : c.status === "ok"
            ? `${c.toolCount} read-only tool${c.toolCount === 1 ? "" : "s"}${c.hiddenCount ? ` · ${c.hiddenCount} hidden (not marked read-only)` : ""} · ${host}`
            : host;
      return `
        <div class="task-list-row account-row">
          <div style="width:200px;flex-shrink:0;padding:0 12px;display:flex;align-items:center;gap:10px">
            <span class="doc-file-icon" style="color:var(--accent)">${icon("plug")}</span>
            <span class="task-row-goal-text">${escapeHtml(c.name)}</span>
          </div>
          <div style="width:140px;flex-shrink:0;padding:0 10px">
            <span class="status-badge ${statusClass}" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600">
              <span class="task-agent-dot" style="background:currentColor"></span>${statusLabel}
            </span>
          </div>
          <div style="flex:1;min-width:0;padding:0 12px;overflow:hidden">
            <span class="task-row-summary-text" style="margin-top:0">${escapeHtml(detail)}</span>
          </div>
          <div class="tasks-col-action" style="width:230px;gap:8px;justify-content:flex-end">
            <button type="button" class="btn-secondary" style="font-size:11.5px;padding:4px 10px" data-remote-mcp-test="${escapeHtml(c.id)}">Test</button>
            <button type="button" class="btn-secondary" style="font-size:11.5px;padding:4px 10px" data-remote-mcp-edit="${escapeHtml(c.id)}">Edit</button>
            <button type="button" class="btn-secondary" style="font-size:11.5px;padding:4px 10px" data-remote-mcp-remove="${escapeHtml(c.id)}">Remove</button>
          </div>
        </div>`;
    })
    .join("");

  return `
    <div class="tasks-list-card" style="margin-top:20px">
      <div class="tasks-toolbar" style="justify-content:space-between">
        <div>
          <div class="task-row-goal-text" style="font-size:14px;font-weight:600">Connected systems (MCP)</div>
          <div class="task-row-summary-text" style="margin-top:2px">ERPs and other systems your agents can read live data from — read-only.</div>
        </div>
        <button type="button" class="btn-primary" id="remote-mcp-add-btn">Add system</button>
      </div>
      <div class="tasks-items-list">
        ${
          error
            ? `<div class="tasks-empty-state"><p class="tasks-empty-text">Couldn't load connected systems: ${escapeHtml(error)}</p></div>`
            : rows ||
              `<div class="tasks-empty-state">
                <div class="tasks-empty-icon">${icon("plug")}</div>
                <div class="tasks-empty-title">${loaded ? "No systems connected" : "Loading…"}</div>
                <p class="tasks-empty-text">${loaded ? "Add your ERP's MCP endpoint and data key so Finance, Analysis, CRM and Sales can use its customers, sales and menu data." : ""}</p>
              </div>`
        }
      </div>
    </div>`;
}

function openRemoteMcpModal(existing) {
  const isNew = !existing;
  const form = {
    name: existing?.name ?? "",
    url: existing?.url ?? "",
    key: "",
    headerName: existing && existing.headerName !== "Authorization" ? existing.headerName : "",
    agents: new Set(existing?.agents ?? REMOTE_MCP_AGENT_OPTIONS.map(([key]) => key)),
  };
  let saving = false;

  const renderer = () => `
    <div class="modal-head"><h2>${isNew ? "Add a connected system" : `Edit ${escapeHtml(existing.name)}`}</h2><button type="button" class="modal-close" id="modal-close-btn">${icon("x")}</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <label>Name<input type="text" data-remote-mcp-field="name" placeholder="e.g. Restaurant ERP" value="${escapeHtml(form.name)}" ${isNew ? "" : "disabled"} /></label>
        <label>MCP URL<input type="url" data-remote-mcp-field="url" placeholder="https://erp.example.com/mcp" value="${escapeHtml(form.url)}" /></label>
        <label>Data access key<input type="password" autocomplete="off" data-remote-mcp-field="key" placeholder="${isNew ? "Paste the key from the ERP" : `Leave blank to keep ${escapeHtml(existing.keyMasked)}`}" value="${escapeHtml(form.key)}" /></label>
        <label>Auth header (optional)<input type="text" data-remote-mcp-field="headerName" placeholder="Authorization (sent as Bearer)" value="${escapeHtml(form.headerName)}" /></label>
      </div>
      <div class="card-title" style="margin:14px 0 6px">Agents that can read from it</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        ${REMOTE_MCP_AGENT_OPTIONS.map(
          ([key, label]) => `<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-remote-mcp-agent="${key}" ${form.agents.has(key) ? "checked" : ""} />${label}</label>`,
        ).join("")}
      </div>
      <p class="task-row-summary-text" style="margin-top:12px">Only tools the system marks read-only are exposed. The key is stored on the server and never shown again.</p>
    </div>
    <div class="modal-footer">
      <span class="modal-footer-spacer"></span>
      <button type="button" class="btn-secondary" id="modal-cancel-btn">Cancel</button>
      <button type="button" class="btn-primary" id="remote-mcp-save-btn" ${saving ? "disabled" : ""}>${saving ? "Connecting…" : isNew ? "Connect" : "Save"}</button>
    </div>
  `;

  modalAttach = () => {
    document.getElementById("modal-close-btn")?.addEventListener("click", closeModal);
    document.getElementById("modal-cancel-btn")?.addEventListener("click", closeModal);
    document.querySelectorAll("[data-remote-mcp-field]").forEach((el) => {
      el.addEventListener("input", (e) => {
        form[el.dataset.remoteMcpField] = e.target.value;
      });
    });
    document.querySelectorAll("[data-remote-mcp-agent]").forEach((el) => {
      el.addEventListener("change", (e) => {
        if (e.target.checked) form.agents.add(el.dataset.remoteMcpAgent);
        else form.agents.delete(el.dataset.remoteMcpAgent);
      });
    });
    document.getElementById("remote-mcp-save-btn")?.addEventListener("click", async () => {
      if (!form.name.trim() || !form.url.trim()) {
        showToast("Name and MCP URL are required.");
        return;
      }
      if (isNew && !form.key.trim()) {
        showToast("The data access key is required.");
        return;
      }
      if (!form.agents.size) {
        showToast("Pick at least one agent.");
        return;
      }
      saving = true;
      openModal(renderer);
      try {
        const result = await fetchJSON("/api/remote-mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            url: form.url.trim(),
            ...(form.key.trim() ? { key: form.key.trim() } : {}),
            headerName: form.headerName.trim(),
            agents: [...form.agents],
          }),
        });
        closeModal();
        await loadRemoteMcp(true);
        showToast(
          result.status === "ok"
            ? `Connected — ${result.toolCount} read-only tool${result.toolCount === 1 ? "" : "s"} available.`
            : `Saved, but couldn't connect: ${result.error || "unknown error"}`,
        );
      } catch (err) {
        saving = false;
        openModal(renderer);
        showToast(err instanceof Error ? err.message : String(err));
      }
    });
  };
  openModal(renderer);
}

VIEW_RENDERERS.accounts = function renderAccountsPage() {
  if (state.accounts.loading && !state.accounts.loaded) return `<div class="stub-placeholder">Loading connections…</div>`;
  if (state.accounts.error) return `<div class="stub-placeholder">Couldn't load connections: ${escapeHtml(state.accounts.error)}</div>`;

  const items = state.accounts.items || [];
  const totalCount = items.length;
  const connectedCount = items.filter((a) => a.connected).length;
  const disconnectedCount = items.filter((a) => !a.connected).length;

  const q = (state.accounts.search || "").trim().toLowerCase();
  const filter = state.accounts.filter || "all";

  const filtered = items.filter((a) => {
    if (filter === "connected" && !a.connected) return false;
    if (filter === "disconnected" && a.connected) return false;
    if (q) {
      const matchLabel = (a.label || "").toLowerCase().includes(q);
      const matchKey = (a.key || "").toLowerCase().includes(q);
      const matchHint = (a.configHint || "").toLowerCase().includes(q);
      if (!matchLabel && !matchKey && !matchHint) return false;
    }
    return true;
  });

  return `
    <div class="tasks-page accounts-page">
      <div class="tasks-header">
        <div class="tasks-header-title-col">
          <div class="tasks-eyebrow">🔌 External Integrations</div>
          <h1 class="tasks-title">Accounts <span class="tasks-count-pill">${totalCount}</span></h1>
          <p class="tasks-subtitle">Connect services and credentials that empower your agents to take real-world action.</p>
        </div>
        <div class="tasks-stats-strip">
          <div class="tasks-stat-chip${filter === "all" ? " active" : ""}" data-account-filter="all">
            <span class="tasks-stat-chip-label">Total</span>
            <span class="tasks-stat-chip-val">${totalCount}</span>
          </div>
          <div class="tasks-stat-chip${filter === "connected" ? " active" : ""}" data-account-filter="connected">
            <span class="tasks-stat-dot success"></span>
            <span class="tasks-stat-chip-label">Connected</span>
            <span class="tasks-stat-chip-val">${connectedCount}</span>
          </div>
          <div class="tasks-stat-chip${filter === "disconnected" ? " active" : ""}" data-account-filter="disconnected">
            <span class="tasks-stat-chip-label">Available</span>
            <span class="tasks-stat-chip-val">${disconnectedCount}</span>
          </div>
        </div>
      </div>

      <div class="tasks-list-card">
        <div class="tasks-toolbar">
          <div class="tasks-search-wrap">
            <span class="tasks-search-icon">${icon("search")}</span>
            <input 
              type="text" 
              id="accounts-search-input" 
              class="tasks-search-input" 
              placeholder="Search accounts and integrations..." 
              value="${escapeHtml(state.accounts.search || "")}"
            />
            ${state.accounts.search ? `<button type="button" class="tasks-search-clear" id="accounts-search-clear" aria-label="Clear">${icon("x")}</button>` : ""}
          </div>
          <div class="tasks-filter-pills">
            <button type="button" class="tasks-filter-pill${filter === "all" ? " active" : ""}" data-account-filter="all">All (${totalCount})</button>
            <button type="button" class="tasks-filter-pill${filter === "connected" ? " active" : ""}" data-account-filter="connected">Connected (${connectedCount})</button>
            <button type="button" class="tasks-filter-pill${filter === "disconnected" ? " active" : ""}" data-account-filter="disconnected">Not Connected (${disconnectedCount})</button>
          </div>
        </div>

        <div class="tasks-list-head-row">
          <div style="width:200px;flex-shrink:0;padding:0 12px">Integration / Service</div>
          <div style="width:140px;flex-shrink:0;padding:0 10px">Status</div>
          <div style="flex:1;min-width:0;padding:0 12px">Method & Details</div>
          <div class="tasks-col-action" style="width:160px;justify-content:flex-end">Action</div>
        </div>

        <div class="tasks-items-list">
          ${
            filtered.length
              ? filtered
                  .map((a) => {
                    const statusClass = a.connected ? "success" : a.unsupported ? "error" : "running";
                    const statusLabel = a.connected ? "Connected" : a.unsupported ? "Unsupported" : "Not connected";
                    const hint = a.configOnly
                      ? (a.configHint || "Configured via an API key in Settings.")
                      : a.unsupported && a.reason
                        ? a.reason
                        : a.connectUrl
                          ? "OAuth direct authorization"
                          : "API connection";
                    return `
              <div class="task-list-row account-row">
                <div style="width:200px;flex-shrink:0;padding:0 12px;display:flex;align-items:center;gap:10px">
                  <span class="doc-file-icon" style="color:var(--accent)">${icon("plug")}</span>
                  <span class="task-row-goal-text">${escapeHtml(a.label)}</span>
                </div>
                <div style="width:140px;flex-shrink:0;padding:0 10px">
                  <span class="status-badge ${statusClass}" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600">
                    <span class="task-agent-dot" style="background:currentColor"></span>
                    ${statusLabel}
                  </span>
                </div>
                <div style="flex:1;min-width:0;padding:0 12px;overflow:hidden">
                  <span class="task-row-summary-text" style="margin-top:0">${escapeHtml(hint)}</span>
                </div>
                <div class="tasks-col-action" style="width:160px;gap:8px;justify-content:flex-end">
                  ${
                    a.connectUrl
                      ? a.connected
                        ? `<button type="button" class="btn-secondary" style="font-size:11.5px;padding:4px 10px" data-disconnect="${a.key}">Disconnect</button>`
                        : `<a class="btn-primary" style="font-size:11.5px;padding:4px 12px;text-decoration:none" href="${escapeHtml(a.connectUrl)}" target="_blank" rel="noopener">Connect</a>`
                      : a.configOnly
                        ? `<button type="button" class="btn-secondary" style="font-size:11.5px;padding:4px 10px" data-goto-settings>Settings</button>${a.signupUrl ? `<a class="btn-secondary" style="font-size:11.5px;padding:4px 8px;text-decoration:none" href="${escapeHtml(a.signupUrl)}" target="_blank" rel="noopener">Key ↗</a>` : ""}`
                        : ""
                  }
                </div>
              </div>
            `;
                  })
                  .join("")
              : `
              <div class="tasks-empty-state">
                <div class="tasks-empty-icon">${icon("plug")}</div>
                <div class="tasks-empty-title">No integrations match</div>
                <p class="tasks-empty-text">Try adjusting your search or filters.</p>
              </div>
            `
          }
        </div>
      </div>
      ${renderRemoteMcpSection()}
    </div>
  `;
};

VIEW_ATTACHERS.push(function attachRemoteMcpHandlers() {
  document.getElementById("remote-mcp-add-btn")?.addEventListener("click", () => openRemoteMcpModal());
  const find = (id) => state.remoteMcp.items.find((c) => c.id === id);

  document.querySelectorAll("[data-remote-mcp-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = find(btn.dataset.remoteMcpEdit);
      if (c) openRemoteMcpModal(c);
    });
  });

  document.querySelectorAll("[data-remote-mcp-test]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const c = find(btn.dataset.remoteMcpTest);
      if (!c) return;
      btn.disabled = true;
      btn.textContent = "Testing…";
      try {
        const result = await fetchJSON(`/api/remote-mcp/${encodeURIComponent(c.id)}/test`, { method: "POST" });
        await loadRemoteMcp(true);
        showToast(
          result.status === "ok"
            ? `${c.name}: connected — ${result.toolCount} read-only tool${result.toolCount === 1 ? "" : "s"}.`
            : `${c.name}: ${result.error || "could not connect"}`,
        );
      } catch (err) {
        await loadRemoteMcp(true);
        showToast(err instanceof Error ? err.message : String(err));
      }
    });
  });

  document.querySelectorAll("[data-remote-mcp-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = find(btn.dataset.remoteMcpRemove);
      if (!c) return;
      openConfirmModal({
        title: `Remove ${c.name}?`,
        message: "Agents will lose access to this system's data. You can add it again later with a data access key.",
        confirmLabel: "Remove",
        onConfirm: async () => {
          await fetchJSON(`/api/remote-mcp/${encodeURIComponent(c.id)}`, { method: "DELETE" });
          await loadRemoteMcp(true);
          showToast(`${c.name} removed.`);
        },
      });
    });
  });
});

VIEW_ATTACHERS.push(function attachAccountsHandlers() {
  const searchInput = document.getElementById("accounts-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.accounts.search = e.target.value;
      render();
      const el = document.getElementById("accounts-search-input");
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }
  document.getElementById("accounts-search-clear")?.addEventListener("click", () => {
    state.accounts.search = "";
    render();
  });

  document.querySelectorAll("[data-account-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.accounts.filter = btn.dataset.accountFilter;
      render();
    });
  });

  document.querySelectorAll("[data-disconnect]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const a = state.accounts.items.find((x) => x.key === btn.dataset.disconnect);
      if (!a) return;
      openConfirmModal({
        title: `Disconnect ${a.label}?`,
        message: "Agents will lose access to this account until you reconnect it.",
        confirmLabel: "Disconnect",
        onConfirm: async () => {
          await fetchJSON(`/api/accounts/${a.key}/disconnect`, { method: "POST" });
          await loadAccounts(true);
          showToast(`${a.label} disconnected.`);
        },
      });
    });
  });
  document.querySelectorAll("[data-goto-settings]").forEach((btn) => {
    btn.addEventListener("click", () => switchView("settings"));
  });
});
