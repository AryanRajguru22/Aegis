// Aegis Trust Mesh dashboard — vanilla JS, no build step, no dependencies.
// Talks only to the endpoints proven in src/api/__tests__ — every field name here
// mirrors those tests' assertions exactly (decision.verdict, execution.success,
// ledger entry {kind, data, prevHash, contentHash, signature}, etc.).

const LS_KEYS = {
  principalId: "aegis_principal_id",
  apiKey: "aegis_principal_key",
  tokens: "aegis_agent_tokens", // { [agentId]: capabilityTokenBase64 }
};

let state = {
  principalId: null,
  apiKey: null,
  agents: [],
  activeAgentId: null,
  attenuateParentId: null, // null => next "Create" targets a root agent
};

// ---------- helpers ----------

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEYS.tokens) || "{}");
  } catch {
    return {};
  }
}
function saveToken(agentId, token) {
  const tokens = loadTokens();
  tokens[agentId] = token;
  localStorage.setItem(LS_KEYS.tokens, JSON.stringify(tokens));
}

function fmtMoney(minorUnits, currency) {
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString();
}
function truncHash(h) {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "";
}
// Deliberately no "html" attribute option here — every dynamic value in this file
// (agent-supplied text, LLM-judge rationale, rail/execution identifiers, error
// messages) must go through .textContent/createTextNode, never innerHTML. See
// renderDecisionResult() and renderError() below, and docs/THREAT_MODEL.md §1.
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

async function api(path, { method = "GET", auth, body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders["content-type"] = "application/json";
  if (auth) finalHeaders["authorization"] = `Bearer ${auth}`;
  const res = await fetch(path, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const message = (json && json.error) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json;
}

function verdictBadge(verdict) {
  const cls = verdict === "allow" ? "allow" : verdict === "deny" ? "deny" : verdict === "escalate" ? "escalate" : "gray";
  return el("span", { class: `badge ${cls}`, text: verdict || "unknown" });
}

// ---------- auth screen ----------

document.getElementById("createPrincipalBtn").addEventListener("click", async () => {
  const principalId = document.getElementById("newPrincipalId").value.trim();
  const errorEl = document.getElementById("authError");
  errorEl.textContent = "";
  if (!principalId) {
    errorEl.textContent = "Enter a principal ID.";
    return;
  }
  try {
    const res = await api("/principals", { method: "POST", body: { principalId } });
    signIn(res.principalId, res.apiKey);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("useExistingKeyBtn").addEventListener("click", async () => {
  const apiKey = document.getElementById("existingApiKey").value.trim();
  const errorEl = document.getElementById("authError");
  errorEl.textContent = "";
  if (!apiKey) {
    errorEl.textContent = "Paste an API key.";
    return;
  }
  try {
    // GET /agents both verifies the key and tells us who we are via the returned agents' principalId.
    const res = await fetch("/agents", { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error("Invalid API key");
    const body = await res.json();
    const principalId = body.agents[0]?.principalId || "(unknown — no agents yet)";
    signIn(principalId, apiKey);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

function signIn(principalId, apiKey) {
  localStorage.setItem(LS_KEYS.principalId, principalId);
  localStorage.setItem(LS_KEYS.apiKey, apiKey);
  state.principalId = principalId;
  state.apiKey = apiKey;
  boot();
}

function signOut() {
  localStorage.removeItem(LS_KEYS.principalId);
  localStorage.removeItem(LS_KEYS.apiKey);
  location.reload();
}

// ---------- agents panel ----------

async function loadAgents() {
  const res = await api("/agents", { auth: state.apiKey });
  state.agents = res.agents;
  renderAgentTree();
}

function renderAgentTree() {
  const container = document.getElementById("agentTree");
  container.innerHTML = "";
  const byParent = new Map();
  for (const a of state.agents) {
    const key = a.parentAgentId || "__root__";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(a);
  }

  function renderLevel(parentKey, depth) {
    const children = byParent.get(parentKey) || [];
    for (const agent of children) {
      container.appendChild(renderAgentNode(agent, depth));
      renderLevel(agent.agentId, depth + 1);
    }
  }
  renderLevel("__root__", 0);

  if (state.agents.length === 0) {
    container.appendChild(el("div", { class: "hint", text: "No agents yet — create a root agent below." }));
  }
}

function renderAgentNode(agent, depth) {
  const node = el("div", { class: `agentNode${agent.agentId === state.activeAgentId ? " active" : ""}` });
  node.style.marginLeft = `${depth * 14}px`;

  const hasToken = Boolean(loadTokens()[agent.agentId]);
  node.appendChild(el("div", { class: "id", text: agent.agentId + (hasToken ? "" : "  (no local token)") }));
  node.appendChild(el("div", { class: "goal", text: agent.delegatedGoal }));
  node.appendChild(
    el("div", {
      class: "caveats",
      text: `cap ${fmtMoney(agent.caveats.maxAmountMinorUnits, agent.caveats.currency)} · ${agent.caveats.categories.join(",")} · ${agent.caveats.rails.join(",")}`,
    })
  );

  const actions = el("div", { class: "actions" });
  const selectBtn = el("button", { class: "secondary", text: "Select" });
  selectBtn.disabled = !hasToken;
  selectBtn.addEventListener("click", () => selectAgent(agent.agentId));
  const attenuateBtn = el("button", { class: "secondary", text: "Attenuate" });
  attenuateBtn.addEventListener("click", () => startAttenuate(agent));
  const revokeBtn = el("button", { class: "danger", text: "Revoke" });
  revokeBtn.addEventListener("click", () => revokeAgent(agent.agentId));
  actions.append(selectBtn, attenuateBtn, revokeBtn);
  node.appendChild(actions);

  return node;
}

function startAttenuate(parent) {
  state.attenuateParentId = parent.agentId;
  document.getElementById("createAgentContext").textContent = `Attenuating a sub-agent under "${parent.agentId}" (caveats must be equal or narrower).`;
  document.getElementById("cancelAttenuateBtn").style.display = "";
  document.getElementById("maxAmount").value = (parent.caveats.maxAmountMinorUnits / 100).toFixed(2);
  document.getElementById("categories").value = parent.caveats.categories.join(",");
  document.getElementById("agentId").focus();
}
document.getElementById("cancelAttenuateBtn").addEventListener("click", () => {
  state.attenuateParentId = null;
  document.getElementById("createAgentContext").textContent = "Creating a root agent.";
  document.getElementById("cancelAttenuateBtn").style.display = "none";
});

document.getElementById("createAgentBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("agentError");
  errorEl.textContent = "";
  const agentId = document.getElementById("agentId").value.trim();
  const delegatedGoal = document.getElementById("delegatedGoal").value.trim();
  const maxAmount = Number(document.getElementById("maxAmount").value);
  const categories = document
    .getElementById("categories")
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rails = [];
  if (document.getElementById("railStripe").checked) rails.push("stripe_test");
  if (document.getElementById("railX402").checked) rails.push("mock_x402");

  if (!agentId || !delegatedGoal || rails.length === 0 || categories.length === 0) {
    errorEl.textContent = "Fill in agent ID, delegated goal, at least one category, and at least one rail.";
    return;
  }

  const caveats = {
    maxAmountMinorUnits: Math.round(maxAmount * 100),
    currency: "USD",
    categories,
    rails,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  };

  try {
    const path = state.attenuateParentId ? `/agents/${state.attenuateParentId}/attenuate` : "/agents";
    const res = await api(path, { method: "POST", auth: state.apiKey, body: { agentId, delegatedGoal, caveats } });
    saveToken(res.agentId, res.token);
    document.getElementById("agentId").value = "";
    document.getElementById("delegatedGoal").value = "";
    state.attenuateParentId = null;
    document.getElementById("createAgentContext").textContent = "Creating a root agent.";
    document.getElementById("cancelAttenuateBtn").style.display = "none";
    await loadAgents();
    selectAgent(res.agentId);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

async function revokeAgent(agentId) {
  if (!confirm(`Revoke "${agentId}"? This cascades to every sub-agent attenuated from it.`)) return;
  try {
    await api(`/agents/${agentId}/revoke`, { method: "POST", auth: state.apiKey, body: { reason: "Revoked from the Aegis dashboard" } });
    await loadAgents();
  } catch (err) {
    alert(err.message);
  }
}

async function selectAgent(agentId) {
  state.activeAgentId = agentId;
  document.getElementById("activeAgentLabel").textContent = agentId;
  renderAgentTree();
  try {
    const graph = await api(`/agents/${agentId}/graph`, { auth: state.apiKey });
    renderGraph(graph);
  } catch {
    /* non-fatal */
  }
}

function renderGraph(graph) {
  const container = document.getElementById("graphView");
  container.innerHTML = "";
  const byParent = new Map();
  for (const a of graph.agents) {
    const key = a.parentAgentId || "__root__";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(a);
  }
  function renderLevel(parentKey, depth) {
    const children = byParent.get(parentKey) || [];
    return children.map((a) => {
      const row = el("div", { text: `${"  ".repeat(depth)}${depth > 0 ? "└─ " : ""}${a.agentId}` });
      row.style.fontFamily = "var(--mono)";
      row.style.fontSize = "12px";
      row.style.color = a.agentId === state.activeAgentId ? "var(--accent)" : "var(--text)";
      return [row, ...renderLevel(a.agentId, depth + 1)];
    }).flat();
  }
  renderLevel("__root__", 0).forEach((n) => container.appendChild(n));
}

// ---------- transactions ----------

function currentTransaction() {
  return {
    amountMinorUnits: Math.round(Number(document.getElementById("txAmount").value) * 100),
    currency: document.getElementById("txCurrency").value.trim(),
    category: document.getElementById("txCategory").value.trim(),
    rail: document.getElementById("txRail").value,
    purpose: document.getElementById("txPurpose").value.trim(),
  };
}

// SECURITY: every field interpolated below (intentJudgment.verdict/rationale,
// baselineFlags[].detail, execution.rail/reference/error) can originate from
// attacker-influenced or AI-generated input — decision.risk.intentJudgment.rationale
// in particular is free text produced by the intent-consistency judge, whose prompt
// embeds the agent-supplied transaction.purpose verbatim (see
// src/risk/anthropicJudge.ts's buildPrompt). None of it is safe to parse as HTML, so
// every dynamic value here is inserted via .textContent/createTextNode — literal text
// insertion, never markup — regardless of what it contains. Only the static label
// strings ("Risk:", "Flags:", "Execution (...):") are ever markup-adjacent, and they
// are fixed, non-dynamic strings.
function renderDecisionResult(container, body) {
  container.innerHTML = ""; // clearing only — never used to insert untrusted content
  if (!body) return;
  const { decision, execution } = body;

  const top = el("div", {}, [verdictBadge(decision.verdict), el("span", { text: " " + decision.reason })]);
  top.style.display = "flex";
  top.style.alignItems = "center";
  top.style.gap = "8px";
  top.style.marginBottom = "6px";
  container.appendChild(top);

  if (decision.risk) {
    const { intentJudgment, baselineFlags } = decision.risk;
    const risk = el("div", { class: "hint" }, [
      el("b", { text: "Risk:", style: "color:var(--text)" }),
      document.createTextNode(` intent=${intentJudgment.verdict} — ${intentJudgment.rationale}`),
    ]);
    if (baselineFlags.length) {
      risk.appendChild(document.createElement("br"));
      risk.appendChild(el("b", { text: "Flags:", style: "color:var(--text)" }));
      risk.appendChild(document.createTextNode(` ${baselineFlags.map((f) => f.detail).join("; ")}`));
    }
    container.appendChild(risk);
  }

  if (execution) {
    const status = execution.success ? `settled — ref ${execution.reference}` : `failed — ${execution.error}`;
    const ex = el("div", { class: "hint" }, [
      el("b", { text: `Execution (${execution.rail}):`, style: "color:var(--text)" }),
      document.createTextNode(` ${status}`),
    ]);
    container.appendChild(ex);
  }
}

/** The one place an error message reaches the DOM — always as literal text, never markup, since err.message can carry API-echoed user input (e.g. a rejected agentId). */
function renderError(container, message) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: "error", text: message }));
}

document.getElementById("simulateBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("result");
  const token = loadTokens()[state.activeAgentId];
  if (!token) {
    renderError(resultEl, "No local token for this agent — select an agent created/attenuated in this browser.");
    return;
  }
  try {
    const res = await api("/simulate", { method: "POST", auth: token, body: { transaction: currentTransaction() } });
    renderDecisionResult(resultEl, res);
  } catch (err) {
    renderError(resultEl, err.message);
  }
});

document.getElementById("executeBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("result");
  const token = loadTokens()[state.activeAgentId];
  if (!token) {
    renderError(resultEl, "No local token for this agent — select an agent created/attenuated in this browser.");
    return;
  }
  const counterparty = document.getElementById("txCounterparty").value.trim();
  try {
    const res = await api("/transactions", {
      method: "POST",
      auth: token,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: { transaction: currentTransaction(), counterparty },
    });
    renderDecisionResult(resultEl, res);
  } catch (err) {
    renderError(resultEl, err.message);
  }
});

// ---------- live feed (SSE via fetch, since EventSource can't send Authorization headers) ----------

function feedCardFor(entry) {
  const card = el("div", { class: "card" });
  const top = el("div", { class: "top" }, [
    el("span", { class: "kind", text: entry.kind }),
    el("span", { class: "time", text: `${entry.agentId} · ${fmtTime(entry.createdAt)}` }),
  ]);
  card.appendChild(top);

  const body = el("div", { class: "body" });
  const d = entry.data || {};
  if (entry.kind === "decision") {
    body.appendChild(verdictBadge(d.verdict));
    body.appendChild(document.createTextNode(" " + (d.reason || "")));
  } else if (entry.kind === "policy_verdict") {
    body.textContent = d.allowed ? "policy check passed" : `policy check failed — ${d.reason}`;
  } else if (entry.kind === "risk_verdict") {
    body.textContent = `intent=${d.intentJudgment?.verdict} — ${d.intentJudgment?.rationale || ""}`;
  } else if (entry.kind === "execution_result") {
    body.textContent = d.success ? `settled on ${d.rail} — ${d.reference}` : `execution failed on ${d.rail} — ${d.error}`;
  } else if (entry.kind === "agent_registered") {
    body.textContent = `${d.parentAgentId ? "sub-agent attenuated under " + d.parentAgentId : "root agent registered"} — "${d.delegatedGoal}"`;
  } else if (entry.kind === "revocation") {
    body.textContent = `revoked — ${d.reason}`;
  } else {
    body.textContent = JSON.stringify(d);
  }
  card.appendChild(body);
  return card;
}

async function startStream() {
  const feed = document.getElementById("feed");
  while (true) {
    try {
      const res = await fetch("/stream", { headers: { authorization: `Bearer ${state.apiKey}` } });
      if (!res.ok || !res.body) throw new Error("stream connection failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const parts = buffered.split("\n\n");
        buffered = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.includes("event: ledger_entry")) continue;
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const entry = JSON.parse(dataLine.slice(6));
          feed.appendChild(feedCardFor(entry));
          while (feed.children.length > 200) feed.removeChild(feed.firstChild);
        }
      }
    } catch {
      /* connection dropped — retry below */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------- ledger ----------

document.getElementById("refreshLedgerBtn").addEventListener("click", refreshLedger);

async function refreshLedger() {
  const statusEl = document.getElementById("chainStatus");
  const listEl = document.getElementById("ledgerEntries");
  try {
    const res = await api("/ledger", { auth: state.apiKey });
    statusEl.className = res.chainValid ? "valid" : "invalid";
    statusEl.textContent = res.chainValid
      ? `✓ Verified — ${res.entries.length} entries, hash-chain intact`
      : `✗ TAMPERED — hash-chain verification failed`;
    listEl.innerHTML = "";
    for (const entry of res.entries.slice().reverse()) {
      const row = el("div", { class: "card" });
      row.appendChild(
        el("div", { class: "top" }, [el("span", { class: "kind", text: `#${entry.seq} ${entry.kind}` }), el("span", { class: "time", text: fmtTime(entry.createdAt) })])
      );
      row.appendChild(el("div", { class: "hash", text: `hash ${truncHash(entry.contentHash)} ← prev ${truncHash(entry.prevHash)}` }));
      listEl.appendChild(row);
    }
  } catch (err) {
    statusEl.className = "invalid";
    statusEl.textContent = err.message;
  }
}

// ---------- boot ----------

function boot() {
  document.getElementById("authScreen").style.display = "none";
  document.getElementById("app").style.display = "block";
  const badge = document.getElementById("principalBadge");
  badge.textContent = state.principalId + "  ";
  const logout = el("a", { class: "link", text: "switch principal" });
  logout.addEventListener("click", signOut);
  badge.appendChild(logout);

  loadAgents();
  refreshLedger();
  startStream();
}

(function init() {
  const apiKey = localStorage.getItem(LS_KEYS.apiKey);
  const principalId = localStorage.getItem(LS_KEYS.principalId);
  if (apiKey && principalId) {
    state.apiKey = apiKey;
    state.principalId = principalId;
    boot();
  }
})();
