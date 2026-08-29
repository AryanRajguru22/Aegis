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
  missions: [],
  viewingMissionId: null,
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

// ---------- decision pipeline (Mission -> Capability & Policy -> Risk -> Decision -> Execution) ----------
// A single, reusable visual vocabulary for "why did/didn't money move" — used both for
// a live Simulate/Execute result and for a mission's historical transaction log (see
// renderMissionHistoryEntry), so a judge sees the identical explanation shape either way.

function stageStatusClass(word) {
  if (word === "allow" || word === "consistent") return "allow";
  if (word === "deny" || word === "inconsistent" || word === "unavailable") return "deny";
  if (word === "escalate" || word === "ambiguous") return "escalate";
  return "gray";
}

function pipelineStage(label, statusWord, detailNodes) {
  const cls = stageStatusClass(statusWord);
  const stage = el("div", { class: `stage stage-${cls}` });
  stage.appendChild(
    el("div", { class: "stageHead" }, [el("span", { class: "stageLabel", text: label }), el("span", { class: `badge ${cls}`, text: statusWord || "—" })])
  );
  stage.appendChild(el("div", { class: "stageDetail" }, detailNodes));
  return stage;
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
  populateMissionAgentSelect();
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

  // When attenuating, default the child's expiresAt to the PARENT's own expiresAt
  // (equal is allowed — validateAttenuation only rejects strictly LATER) rather than
  // always computing a fresh "now + 365 days": since attenuation happens even a
  // moment after the parent's own creation, a freshly-computed "+365 days from now"
  // is later than the parent's own "+365 days from an earlier now" essentially every
  // time, which made the Attenuate flow fail this narrowing check on almost every
  // real attempt. There is no expiresAt input field in this form; this is the
  // create/attenuate submit handler's own default, not a value from the parent's
  // record being blindly trusted as a security decision — validateAttenuation (and
  // the token's own cryptographic check) still independently enforce "equal or
  // narrower" regardless of what this default computes.
  const parentAgent = state.attenuateParentId ? state.agents.find((a) => a.agentId === state.attenuateParentId) : null;
  const expiresAt = parentAgent ? parentAgent.caveats.expiresAt : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const caveats = {
    maxAmountMinorUnits: Math.round(maxAmount * 100),
    currency: "USD",
    categories,
    rails,
    expiresAt,
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
  populateTxMissionSelect();
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
// baselineFlags[].detail, execution.rail/reference/error, a mission's own deny
// reason) can originate from attacker-influenced or AI-generated input —
// decision.risk.intentJudgment.rationale in particular is free text produced by the
// intent-consistency judge, whose prompt embeds the agent-supplied transaction.purpose
// verbatim (see src/risk/anthropicJudge.ts's buildPrompt). None of it is safe to parse
// as HTML, so every dynamic value here is inserted via .textContent/createTextNode
// (directly, or via pipelineStage's own use of the same) — literal text insertion,
// never markup — regardless of what it contains, even when a payload is first
// concatenated into a JS template string before being handed to .textContent: that
// concatenation never causes it to be parsed as markup, since .textContent has no
// parsing step at all. Only static label strings ("Risk", "Decision", "Execution
// (...)") are ever markup-adjacent, and they are fixed, non-dynamic strings.
//
// options.missionUsed / options.missionId: purely presentational — whether the CALLER
// knows a missionId was submitted alongside this request. The API response itself
// carries decision.source === "mission" only for a mission-GATE denial (nothing
// downstream of the gate ever ran); for an ALLOWED mission-scoped transaction the
// full existing pipeline still runs exactly as before, so this is the only way the
// renderer can show the "Mission" stage passed.
function renderDecisionResult(container, body, options = {}) {
  container.innerHTML = ""; // clearing only — never used to insert untrusted content
  if (!body) return;
  const { decision, execution } = body;
  const missionLabel = options.missionId ? `Mission (${options.missionId})` : "Mission";

  const top = el("div", {}, [verdictBadge(decision.verdict), el("span", { text: " " + decision.reason })]);
  top.style.display = "flex";
  top.style.alignItems = "center";
  top.style.gap = "8px";
  top.style.marginBottom = "10px";
  container.appendChild(top);

  const pipeline = el("div", { class: "pipeline" });

  if (decision.source === "mission") {
    // The mission gate denied this attempt before capability/policy/risk/execution
    // ever ran — nothing downstream exists to show.
    pipeline.appendChild(pipelineStage(missionLabel, "deny", [el("span", { text: decision.reason })]));
    container.appendChild(pipeline);
    return;
  }

  if (options.missionUsed) {
    pipeline.appendChild(pipelineStage(missionLabel, "allow", [el("span", { text: "Gate passed — budget reserved for this attempt" })]));
  }

  if (decision.policy) {
    pipeline.appendChild(
      pipelineStage("Capability & Policy", decision.policy.allowed ? "allow" : "deny", [
        el("span", { text: decision.policy.reason || "All capability-token caveats satisfied" }),
      ])
    );
  }

  if (decision.risk) {
    const { intentJudgment, baselineFlags } = decision.risk;
    const riskNodes = [el("b", { text: "Intent: ", style: "color:var(--text)" }), document.createTextNode(`${intentJudgment.verdict} — ${intentJudgment.rationale}`)];
    if (baselineFlags.length) {
      riskNodes.push(document.createElement("br"));
      riskNodes.push(el("b", { text: "Behavioral: ", style: "color:var(--text)" }));
      riskNodes.push(document.createTextNode(baselineFlags.map((f) => f.detail).join("; ")));
    }
    pipeline.appendChild(pipelineStage("Risk (Intent + Behavioral)", intentJudgment.verdict, riskNodes));
  }

  pipeline.appendChild(pipelineStage("Decision", decision.verdict, [el("span", { text: decision.reason })]));

  if (execution) {
    const status = execution.success ? `settled — ref ${execution.reference}` : `failed — ${execution.error}`;
    pipeline.appendChild(pipelineStage(`Execution (${execution.rail})`, execution.success ? "allow" : "deny", [el("span", { text: status })]));
  }

  container.appendChild(pipeline);
}

/** The one place an error message reaches the DOM — always as literal text, never markup, since err.message can carry API-echoed user input (e.g. a rejected agentId). */
function renderError(container, message) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: "error", text: message }));
}

function selectedMissionId() {
  const value = document.getElementById("txMission").value;
  return value || undefined;
}

// Simulate and Execute are two separate click handlers, but both write into the same
// #result panel — so a race isn't limited to double-clicking one button; clicking
// Simulate then quickly clicking Execute (or vice versa) before the first request
// settles is the same hazard. One shared, monotonically increasing counter covers
// both: each handler captures its own value the instant it starts (synchronously,
// before anything async happens, so two overlapping clicks can never both capture the
// same value — JS event handlers run to completion or to their next `await` with no
// preemption). Before either handler renders a result OR an error, it checks that its
// captured value is still the CURRENT counter value; if some later click has since
// started, its own response is stale and is silently discarded instead of overwriting
// whatever that newer click already displayed (or will display). This fixes exactly
// the race found during Step 6's real-browser verification, without touching api(),
// renderDecisionResult(), renderError(), or anything server-side.
let latestResultRequestId = 0;

document.getElementById("simulateBtn").addEventListener("click", async () => {
  const requestId = ++latestResultRequestId;
  const resultEl = document.getElementById("result");
  const token = loadTokens()[state.activeAgentId];
  if (!token) {
    renderError(resultEl, "No local token for this agent — select an agent created/attenuated in this browser.");
    return;
  }
  const missionId = selectedMissionId();
  const counterparty = document.getElementById("txCounterparty").value.trim();
  try {
    const body = { transaction: currentTransaction() };
    if (missionId) {
      body.missionId = missionId;
      body.counterparty = counterparty; // required by /simulate only when a mission is attached
    }
    const res = await api("/simulate", { method: "POST", auth: token, body });
    if (requestId !== latestResultRequestId) return; // a newer Simulate/Execute click has since started — this response is stale
    renderDecisionResult(resultEl, res, { missionUsed: Boolean(missionId), missionId });
  } catch (err) {
    if (requestId !== latestResultRequestId) return; // stale — a newer click already owns the panel
    renderError(resultEl, err.message);
  }
});

document.getElementById("executeBtn").addEventListener("click", async () => {
  const requestId = ++latestResultRequestId;
  const resultEl = document.getElementById("result");
  const token = loadTokens()[state.activeAgentId];
  if (!token) {
    renderError(resultEl, "No local token for this agent — select an agent created/attenuated in this browser.");
    return;
  }
  const missionId = selectedMissionId();
  const counterparty = document.getElementById("txCounterparty").value.trim();
  try {
    const body = { transaction: currentTransaction(), counterparty };
    if (missionId) body.missionId = missionId;
    const res = await api("/transactions", {
      method: "POST",
      auth: token,
      headers: { "idempotency-key": crypto.randomUUID() },
      body,
    });
    if (requestId !== latestResultRequestId) return; // a newer Simulate/Execute click has since started — this response is stale
    renderDecisionResult(resultEl, res, { missionUsed: Boolean(missionId), missionId });
    if (missionId) await loadMissions(); // refresh budget/spent/reserved figures after a mission-scoped attempt — always reflects real server state, independent of #result staleness
  } catch (err) {
    if (requestId !== latestResultRequestId) return; // stale — a newer click already owns the panel
    renderError(resultEl, err.message);
  }
});

// ---------- missions ----------

function statusBadgeClass(status) {
  if (status === "active") return "allow";
  if (status === "completed") return "gray";
  return "deny"; // cancelled / expired
}

async function loadMissions() {
  const res = await api("/missions", { auth: state.apiKey });
  state.missions = res.missions;
  renderMissionList();
  populateTxMissionSelect();
  if (state.viewingMissionId) viewMissionDetail(state.viewingMissionId);
}

function populateMissionAgentSelect() {
  const select = document.getElementById("missionAgentId");
  const previous = select.value;
  select.innerHTML = "";
  for (const agent of state.agents) {
    select.appendChild(el("option", { value: agent.agentId, text: agent.agentId }));
  }
  if (state.agents.some((a) => a.agentId === previous)) select.value = previous;
}

/** The optional Mission dropdown on the transaction form only ever offers ACTIVE missions belonging to the currently selected agent — an agent can't accidentally submit against another agent's mission or a closed one from the UI (the API enforces this regardless; this is just not offering a doomed option). */
function populateTxMissionSelect() {
  const select = document.getElementById("txMission");
  select.innerHTML = "";
  select.appendChild(el("option", { value: "", text: "None — use the agent's standing authority" }));
  for (const m of state.missions) {
    if (m.agentId !== state.activeAgentId || m.status !== "active") continue;
    select.appendChild(el("option", { value: m.missionId, text: `${m.missionId} — ${m.goal.slice(0, 60)}` }));
  }
}

function renderMissionList() {
  const container = document.getElementById("missionList");
  container.innerHTML = "";
  if (state.missions.length === 0) {
    container.appendChild(el("div", { class: "hint", text: "No missions yet — create one below." }));
    return;
  }
  for (const m of state.missions) container.appendChild(renderMissionCard(m));
}

function renderMissionCard(m) {
  const card = el("div", { class: `missionCard${m.missionId === state.viewingMissionId ? " active" : ""}` });
  card.appendChild(
    el("div", { class: "top" }, [el("span", { class: "id", text: m.missionId }), el("span", { class: `badge ${statusBadgeClass(m.status)}`, text: m.status })])
  );
  card.appendChild(el("div", { class: "goal", text: m.goal }));
  card.appendChild(el("div", { class: "hint", text: `agent: ${m.agentId}` }));
  card.appendChild(
    el("div", { class: "hint" }, [
      document.createTextNode(
        `budget ${fmtMoney(m.budgetMinorUnits, m.currency)} · spent ${fmtMoney(m.spentMinorUnits, m.currency)} · reserved ${fmtMoney(m.reservedMinorUnits, m.currency)} · remaining ${fmtMoney(m.remainingMinorUnits, m.currency)}`
      ),
    ])
  );
  card.appendChild(el("div", { class: "hint", text: `categories: ${m.allowedCategories ? m.allowedCategories.join(", ") : "(same as agent token)"}` }));
  card.appendChild(el("div", { class: "hint", text: `approved counterparties: ${m.approvedCounterparties ? m.approvedCounterparties.join(", ") : "(unrestricted)"}` }));
  card.appendChild(el("div", { class: "hint", text: `expires ${new Date(m.expiresAt).toLocaleString()}` }));

  card.addEventListener("click", () => viewMissionDetail(m.missionId));

  const actions = el("div", { class: "actions" });
  if (m.status === "active") {
    const cancelBtn = el("button", { class: "danger", text: "Cancel" });
    cancelBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      cancelMission(m.missionId);
    });
    actions.appendChild(cancelBtn);
  }
  card.appendChild(actions);
  return card;
}

document.getElementById("createMissionBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("missionError");
  errorEl.textContent = "";
  const missionId = document.getElementById("missionIdInput").value.trim();
  const agentId = document.getElementById("missionAgentId").value;
  const goal = document.getElementById("missionGoal").value.trim();
  const budget = Number(document.getElementById("missionBudget").value);
  const currency = document.getElementById("missionCurrency").value.trim();
  const categories = document.getElementById("missionCategories").value.split(",").map((s) => s.trim()).filter(Boolean);
  const counterparties = document.getElementById("missionCounterparties").value.split(",").map((s) => s.trim()).filter(Boolean);
  const days = Number(document.getElementById("missionExpiryDays").value) || 30;

  if (!missionId || !agentId || !goal || !budget || !currency) {
    errorEl.textContent = "Fill in mission ID, agent, goal, budget, and currency.";
    return;
  }

  try {
    await api("/missions", {
      method: "POST",
      auth: state.apiKey,
      body: {
        missionId,
        agentId,
        goal,
        budgetMinorUnits: Math.round(budget * 100),
        currency,
        allowedCategories: categories.length ? categories : null,
        approvedCounterparties: counterparties.length ? counterparties : null,
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    document.getElementById("missionIdInput").value = "";
    document.getElementById("missionGoal").value = "";
    document.getElementById("missionCategories").value = "";
    document.getElementById("missionCounterparties").value = "";
    await loadMissions();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

async function cancelMission(missionId) {
  if (!confirm(`Cancel mission "${missionId}"? No further transactions will be permitted under it.`)) return;
  try {
    await api(`/missions/${encodeURIComponent(missionId)}/cancel`, { method: "POST", auth: state.apiKey });
    await loadMissions();
  } catch (err) {
    alert(err.message);
  }
}

/**
 * Selects the ledger entries that together make up a mission's own history — every
 * mission-scoped transaction attempt, regardless of outcome, in exactly two
 * mission-tagged kinds:
 *
 *  - mission_policy_verdict: denied by the mission gate itself, before the real
 *    capability/decision/risk/execution pipeline ever ran.
 *  - mission_pipeline_outcome: the FULL outcome of an attempt that reached the real
 *    pipeline — allow+settled, allow+execution-failed, deny (by capability/policy), or
 *    escalate — written by routes/transactions.ts for every such verdict (see
 *    src/mission/ledger.ts's doc comment on LEDGER_KIND_MISSION_PIPELINE_OUTCOME).
 *
 * Both kinds are fully self-contained (their own `data` already carries everything
 * needed to render — verdict, reason, policy, risk, execution), so unlike the
 * seq-offset correlation this function used to do, nothing here needs to go looking
 * at OTHER nearby ledger entries and guess which ones belong to this attempt — which
 * also means there is no way for an unrelated transaction (no mission, or a
 * DIFFERENT mission) to be misattributed here, by construction, not by careful offset
 * arithmetic. mission_transaction_link (settlement bookkeeping, still the sole thing
 * computeMissionSpent reads — unrelated to and unaffected by this function) is
 * deliberately never selected here directly: a successful settlement is already fully
 * represented by its accompanying mission_pipeline_outcome entry, and showing both
 * would double up the same attempt as two history rows.
 */
function selectMissionHistoryEvents(allEntries, missionId) {
  return allEntries
    .filter((e) => (e.kind === "mission_policy_verdict" || e.kind === "mission_pipeline_outcome") && e.data && e.data.missionId === missionId)
    .slice()
    .sort((a, b) => b.seq - a.seq); // most recent first
}

/** Reconstructs the DecisionResult-ish shape renderDecisionResult already knows how to draw, directly from one self-contained mission history entry — reusing the exact same rendering (and the exact same XSS-safety guarantees) for historical entries as for a live result. */
function historyEventToDecisionBody(event) {
  if (event.kind === "mission_policy_verdict") {
    return { decision: { verdict: "deny", reason: event.data.reason, source: "mission" } };
  }
  // mission_pipeline_outcome — already carries the full decision (and execution, if any) verbatim.
  const d = event.data;
  const decision = { verdict: d.verdict, reason: d.reason, policy: d.policy };
  if (d.risk) decision.risk = d.risk;
  return { decision, execution: d.execution };
}

function renderMissionHistoryEntry(missionId, event) {
  const wrapper = el("div", { class: "card" });
  wrapper.appendChild(el("div", { class: "top" }, [el("span", { class: "kind", text: `#${event.seq}` }), el("span", { class: "time", text: fmtTime(event.createdAt) })]));
  const body = el("div", {});
  wrapper.appendChild(body);
  renderDecisionResult(body, historyEventToDecisionBody(event), { missionUsed: true, missionId });
  return wrapper;
}

async function viewMissionDetail(missionId) {
  state.viewingMissionId = missionId;
  renderMissionList(); // to reflect the "active" highlight
  const container = document.getElementById("missionDetail");
  container.innerHTML = "";
  container.appendChild(el("div", { class: "hint", text: "Loading…" }));
  try {
    const mission = await api(`/missions/${encodeURIComponent(missionId)}`, { auth: state.apiKey });
    const ledgerRes = await api(`/ledger?agentId=${encodeURIComponent(mission.agentId)}`, { auth: state.apiKey });
    renderMissionDetail(mission, ledgerRes.entries);
  } catch (err) {
    renderError(container, err.message);
  }
}

function renderMissionDetail(mission, ledgerEntries) {
  const container = document.getElementById("missionDetail");
  container.innerHTML = "";

  container.appendChild(el("h3", { text: mission.missionId }));
  container.appendChild(el("div", { class: "top" }, [el("span", { class: `badge ${statusBadgeClass(mission.status)}`, text: mission.status })]));
  container.appendChild(el("div", { class: "goal", text: mission.goal, style: "margin:8px 0" }));
  container.appendChild(
    el("div", { class: "hint" }, [
      document.createTextNode(
        `budget ${fmtMoney(mission.budgetMinorUnits, mission.currency)} · spent ${fmtMoney(mission.spentMinorUnits, mission.currency)} · reserved ${fmtMoney(mission.reservedMinorUnits, mission.currency)} · remaining ${fmtMoney(mission.remainingMinorUnits, mission.currency)}`
      ),
    ])
  );
  container.appendChild(el("div", { class: "hint", text: `agent: ${mission.agentId}` }));
  container.appendChild(el("div", { class: "hint", text: `categories: ${mission.allowedCategories ? mission.allowedCategories.join(", ") : "(same as agent token)"}` }));
  container.appendChild(el("div", { class: "hint", text: `approved counterparties: ${mission.approvedCounterparties ? mission.approvedCounterparties.join(", ") : "(unrestricted)"}` }));
  container.appendChild(el("div", { class: "hint", text: `expires ${new Date(mission.expiresAt).toLocaleString()}` }));

  const historyContainer = el("div", { id: "missionHistory" });
  const history = selectMissionHistoryEvents(ledgerEntries, mission.missionId);
  if (history.length === 0) {
    historyContainer.appendChild(el("div", { class: "hint", text: "No transactions attempted under this mission yet." }));
  } else {
    for (const event of history) historyContainer.appendChild(renderMissionHistoryEntry(mission.missionId, event));
  }
  container.appendChild(historyContainer);
}

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
  } else if (entry.kind === "mission_created") {
    body.textContent = `mission "${d.missionId}" created — budget ${fmtMoney(d.budgetMinorUnits, d.currency)} — "${d.goal}"`;
  } else if (entry.kind === "mission_cancelled") {
    body.textContent = `mission "${d.missionId}" cancelled`;
  } else if (entry.kind === "mission_policy_verdict") {
    body.appendChild(verdictBadge("deny"));
    body.appendChild(document.createTextNode(` mission "${d.missionId}" gate — ${d.reason || ""}`));
  } else if (entry.kind === "mission_transaction_link") {
    body.appendChild(verdictBadge(d.success ? "allow" : "deny"));
    body.appendChild(document.createTextNode(` mission "${d.missionId}" — ${(d.amountMinorUnits / 100).toFixed(2)} ${d.success ? "settled" : "not settled"}`));
  } else if (entry.kind === "mission_pipeline_outcome") {
    body.appendChild(verdictBadge(d.verdict));
    body.appendChild(document.createTextNode(` mission "${d.missionId}" — ${d.reason || ""}`));
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

  checkDemoMode();
  loadAgents();
  loadMissions();
  refreshLedger();
  startStream();
}

// Unauthenticated on purpose (see src/api/server.ts's GET /demo-mode). Called from
// boot() — not at page load — because the three existing dashboard test files (see
// src/api/__tests__/dashboard-*.test.ts) load app.js via vm.runInContext, which runs
// this file's top-level init() IIFE automatically; calling this unconditionally there
// previously caused an uncounted, never-resolving fetch that broke those tests' own
// concurrent-request-counting assumptions (found and fixed in Step 12) — so it only
// ever runs once a real sign-in has actually happened. This is purely a display flag;
// it never changes which endpoints the dashboard calls or how a result is interpreted
// — the server-side judge/rail selection (src/api/demoMode.ts) is what actually makes
// demo mode a demo, not anything client-side. Also toggles the Step 13 "Attack
// Theatre" panel — its scenarios talk to real endpoints regardless, but the panel
// itself is hidden outside demo mode so a production dashboard never shows it.
async function checkDemoMode() {
  try {
    const res = await fetch("/demo-mode");
    if (!res.ok) return;
    const body = await res.json();
    const banner = document.getElementById("demoModeBanner");
    const theatre = document.getElementById("demoTheatre");
    if (body.demoMode) {
      banner.textContent = "⚠ LOCAL DEMO MODE — deterministic judge / mock rail — no real money moves";
      banner.style.display = "block";
      theatre.style.display = "block";
    } else {
      banner.style.display = "none";
      theatre.style.display = "none";
    }
  } catch {
    /* non-fatal — the dashboard still works, it just won't show the demo-mode banner/theatre */
  }
}

// ---------- demo theatre (Step 13) — Scenario A: concurrent budget race ----------
// Every attempt below is a real POST /transactions call against the real,
// unmodified pipeline (checkMissionGate -> MissionReservationStore.reserve()'s single
// atomic SQL UPDATE) — nothing here is simulated or pre-computed. See
// src/mission/reservation.ts and src/mission/__tests__/mission-reservation.test.ts for
// the same guarantee proven directly against the primitive.

let attackMissionId = null;
let attackAgentId = null;
const ATTACK_ATTEMPT_COUNT = 20;
// Deliberately matches src/api/main.ts's demo mock-merchant catalog entry for
// "acme-airlines:flights" ($380) exactly — the mock_x402 rail rejects any amount
// that doesn't match its fixed quoted price, so a mismatched amount here would make
// every "allow" decision fail at settlement, decoupling the displayed counters from
// real spend. Hardcoded (not read from the main transaction form) so this scenario is
// deterministic regardless of what the presenter last typed into that form.
const ATTACK_COUNTERPARTY = "acme-airlines";
const ATTACK_CATEGORY = "flights";
const ATTACK_RAIL = "mock_x402"; // the only rail registered in demo mode
const ATTACK_AMOUNT_MINOR_UNITS = 38_000; // $380 per attempt against a $2,000 mission budget — 5 settle, 15 don't

async function attackCreateMission() {
  const infoEl = document.getElementById("attackMissionInfo");
  if (!state.activeAgentId) {
    infoEl.textContent = "Select an agent (left panel) before creating an attack mission.";
    return;
  }
  const missionId = `attack-${Date.now()}`;
  try {
    await api("/missions", {
      method: "POST",
      auth: state.apiKey,
      body: {
        missionId,
        agentId: state.activeAgentId,
        goal: "Attack-theatre demo mission — bounded budget for a live concurrency demonstration.",
        budgetMinorUnits: 200_000,
        currency: "USD",
        allowedCategories: null,
        approvedCounterparties: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    attackMissionId = missionId;
    attackAgentId = state.activeAgentId;
    infoEl.textContent = `Mission "${missionId}" ready — budget $2,000.00, agent ${state.activeAgentId}.`;
    document.getElementById("attackVerified").textContent = "";
    await loadMissions();
  } catch (err) {
    infoEl.textContent = `Failed to create attack mission: ${err.message}`;
  }
}

function attackUpdateStats(counters) {
  document.getElementById("attackStatAttempts").textContent = String(counters.attempts);
  document.getElementById("attackStatAllowed").textContent = String(counters.allowed);
  document.getElementById("attackStatBlocked").textContent = String(counters.blocked);
  document.getElementById("attackStatSpend").textContent = fmtMoney(counters.spendMinorUnits, "USD");
}

async function launchBudgetAttack() {
  const infoEl = document.getElementById("attackMissionInfo");
  const summaryEl = document.getElementById("attackSummary");
  const attemptsEl = document.getElementById("attackAttempts");
  const verifiedEl = document.getElementById("attackVerified");

  if (!attackMissionId || !attackAgentId) {
    infoEl.textContent = "Create an attack mission first.";
    return;
  }
  const token = loadTokens()[attackAgentId];
  if (!token) {
    infoEl.textContent = "No local token for the attack agent — re-select it.";
    return;
  }

  const category = ATTACK_CATEGORY;
  const rail = ATTACK_RAIL;
  const counterparty = ATTACK_COUNTERPARTY;

  attemptsEl.innerHTML = "";
  verifiedEl.textContent = "";
  summaryEl.style.display = "flex";
  const counters = { attempts: 0, allowed: 0, blocked: 0, spendMinorUnits: 0 };
  attackUpdateStats(counters);

  const rows = [];
  const statusSpans = [];
  for (let i = 0; i < ATTACK_ATTEMPT_COUNT; i++) {
    const statusSpan = el("span", { class: "attemptStatus", text: "pending…" });
    const row = el("div", { class: "attemptRow pending" }, [el("span", { text: `#${i + 1}` }), statusSpan]);
    attemptsEl.appendChild(row);
    rows.push(row);
    statusSpans.push(statusSpan);
  }

  const fireOne = async (i) => {
    counters.attempts++;
    attackUpdateStats(counters);
    let allowed = false;
    let statusText = "ERROR";
    try {
      const res = await api("/transactions", {
        method: "POST",
        auth: token,
        headers: { "idempotency-key": crypto.randomUUID() },
        body: {
          transaction: { amountMinorUnits: ATTACK_AMOUNT_MINOR_UNITS, currency: "USD", category, rail, purpose: "Attack-theatre concurrency probe" },
          counterparty,
          missionId: attackMissionId,
        },
      });
      allowed = Boolean(res.decision && res.decision.verdict === "allow");
      // Only a genuine settlement (execution.success) counts toward "spend" — a
      // decision-layer "allow" whose rail call then failed spent nothing, exactly as
      // computeMissionSpent (the server's own authoritative figure) already treats it.
      const settled = allowed && Boolean(res.execution && res.execution.success);
      statusText = allowed ? (settled ? "ALLOW" : "ALLOW (unsettled)") : "DENY";
      if (allowed) {
        counters.allowed++;
        if (settled) counters.spendMinorUnits += ATTACK_AMOUNT_MINOR_UNITS;
      } else {
        counters.blocked++;
      }
    } catch (err) {
      statusText = "ERROR";
      counters.blocked++;
    }
    rows[i].className = `attemptRow ${allowed ? "allow" : "deny"}`;
    statusSpans[i].textContent = statusText;
    attackUpdateStats(counters);
  };

  await Promise.all(Array.from({ length: ATTACK_ATTEMPT_COUNT }, (_, i) => fireOne(i)));

  // The counters above are a live, client-side tally of what each real response said —
  // this final check independently re-fetches the mission's own authoritative,
  // server-computed state (spentMinorUnits is derived entirely from the ledger, per
  // src/mission/ledger.ts's computeMissionSpent) so the displayed numbers are PROVEN
  // to match real server-side state, not merely self-consistent with the tally above.
  try {
    const mission = await api(`/missions/${encodeURIComponent(attackMissionId)}`, { auth: state.apiKey });
    const overspend = Math.max(0, mission.spentMinorUnits - mission.budgetMinorUnits);
    verifiedEl.textContent =
      `Server-confirmed: spent ${fmtMoney(mission.spentMinorUnits, mission.currency)} of ${fmtMoney(mission.budgetMinorUnits, mission.currency)} budget ` +
      `— remaining ${fmtMoney(mission.remainingMinorUnits, mission.currency)} — overspend ${fmtMoney(overspend, mission.currency)}.`;
  } catch (err) {
    verifiedEl.textContent = `Could not confirm server-side mission state: ${err.message}`;
  }
}

// ---------- demo theatre (Step 13) — Scenario B/D: delegation chain + revocation ----------
// Shared by both scenarios: D is the chain visual itself (narrowing authority,
// rendered truthfully from the same caveats the real capability token was minted
// with); B additionally runs a real transaction before and after a real revocation.
// Every API call below is the existing, unmodified /agents, /agents/:id/attenuate,
// /agents/:id/revoke, and /transactions routes.

/** chain: array of {role, agentId, caveats, revoked}, root first. Visualization only — reads back the SAME caveats already sent to POST /agents / POST /agents/:id/attenuate, never re-derives or asserts anything about token internals. */
function renderDelegationChain(container, chain) {
  container.innerHTML = "";
  chain.forEach((node, i) => {
    if (i > 0) container.appendChild(el("div", { class: "chainArrow", text: "↓" }));
    const nodeEl = el("div", { class: `chainNode${node.revoked ? " revoked" : ""}` });
    const top = el("div", { class: "chainTop" }, [el("span", { class: "chainRole", text: node.role })]);
    if (node.revoked) top.appendChild(el("span", { class: "lockBadge", text: "🔒 REVOKED" }));
    nodeEl.appendChild(top);
    nodeEl.appendChild(el("div", { class: "chainId", text: node.agentId }));
    nodeEl.appendChild(
      el("div", { class: "chainCaveats" }, [
        document.createTextNode(fmtMoney(node.caveats.maxAmountMinorUnits, node.caveats.currency)),
        document.createElement("br"),
        document.createTextNode(node.caveats.categories.join(" · ")),
        document.createElement("br"),
        document.createTextNode(node.caveats.rails.join(" · ")),
      ])
    );
    container.appendChild(nodeEl);
  });
  container.appendChild(
    el("div", { class: "narrowTagline" }, [
      el("span", { class: "can", text: "AUTHORITY CAN NARROW" }),
      document.createTextNode("   ·   "),
      el("span", { class: "cannot", text: "AUTHORITY CANNOT WIDEN" }),
    ])
  );
}

function renderRevocationResult(label, result, railCalls) {
  const wrapper = el("div", { class: "card", style: "margin-top:8px" });
  wrapper.appendChild(el("div", { class: "top" }, [el("span", { class: "kind", text: label })]));
  const body = el("div", { class: "body" });
  if (result && result.__error) {
    body.appendChild(document.createTextNode(result.__error));
  } else if (result && result.decision) {
    body.appendChild(verdictBadge(result.decision.verdict));
    body.appendChild(document.createTextNode(" " + result.decision.reason));
  } else {
    body.appendChild(document.createTextNode("(no result)"));
  }
  wrapper.appendChild(body);
  if (railCalls !== undefined) {
    wrapper.appendChild(el("div", { class: "hint", text: `RAIL CALLS AFTER REVOCATION: ${railCalls}` }));
  }
  return wrapper;
}

async function runRevocationScenario() {
  const btn = document.getElementById("revocationRunBtn");
  const chainEl = document.getElementById("chainVisual");
  const resultsEl = document.getElementById("revocationResults");
  resultsEl.innerHTML = "";
  btn.disabled = true;
  try {
    const suffix = Date.now();
    const parentId = `demo-parent-${suffix}`;
    const childId = `demo-child-${suffix}`;

    const parentCaveats = {
      maxAmountMinorUnits: 200_000,
      currency: "USD",
      categories: ["flights", "hotels", "software"],
      rails: ["stripe_test", "mock_x402"],
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const parentRes = await api("/agents", { method: "POST", auth: state.apiKey, body: { agentId: parentId, delegatedGoal: "Attack-theatre demo parent.", caveats: parentCaveats } });
    saveToken(parentId, parentRes.token);

    const childCaveats = {
      maxAmountMinorUnits: 50_000,
      currency: "USD",
      categories: ["flights"],
      rails: ["mock_x402"],
      expiresAt: parentCaveats.expiresAt,
    };
    const childRes = await api(`/agents/${parentId}/attenuate`, { method: "POST", auth: state.apiKey, body: { agentId: childId, delegatedGoal: "Attack-theatre demo child.", caveats: childCaveats } });
    saveToken(childId, childRes.token);

    renderDelegationChain(chainEl, [
      { role: "PARENT", agentId: parentId, caveats: parentCaveats, revoked: false },
      { role: "CHILD (attenuated)", agentId: childId, caveats: childCaveats, revoked: false },
    ]);

    const txBody = {
      transaction: { amountMinorUnits: 38_000, currency: "USD", category: "flights", rail: "mock_x402", purpose: "Attack-theatre revocation probe" },
      counterparty: "acme-airlines",
    };

    const before = await api("/transactions", { method: "POST", auth: childRes.token, headers: { "idempotency-key": crypto.randomUUID() }, body: txBody }).catch((err) => ({ __error: err.message }));
    resultsEl.appendChild(renderRevocationResult("BEFORE REVOCATION", before));

    await api(`/agents/${childId}/revoke`, { method: "POST", auth: state.apiKey, body: { reason: "Attack-theatre demo revocation" } });
    renderDelegationChain(chainEl, [
      { role: "PARENT", agentId: parentId, caveats: parentCaveats, revoked: false },
      { role: "CHILD (attenuated)", agentId: childId, caveats: childCaveats, revoked: true },
    ]);

    const after = await api("/transactions", { method: "POST", auth: childRes.token, headers: { "idempotency-key": crypto.randomUUID() }, body: txBody }).catch((err) => ({ __error: err.message }));
    // "Rail calls" is read directly off the real response's own shape — execution is
    // only ever present when verdict === "allow" (see executeTransaction's own,
    // unmodified contract) — never asserted or assumed independent of what the server
    // actually returned.
    const railCalls = after && after.execution ? 1 : 0;
    resultsEl.appendChild(renderRevocationResult("AFTER REVOCATION", after, railCalls));
  } catch (err) {
    resultsEl.appendChild(el("div", { class: "error", text: err.message }));
  } finally {
    btn.disabled = false;
  }
}

// ---------- demo theatre (Step 13) — Scenario C: ledger integrity ----------
// checkIntegrity() reads GET /ledger's existing, unmodified chainValid field
// (src/state/ledger.ts's verifyChain(), untouched). tamperLatestEntry() is the ONLY
// call in this whole feature to the one new, narrowly-scoped, demo-mode-only backend
// route (src/api/demoTamper.ts) — see that file for exactly what it does and does not
// allow.

async function checkIntegrity() {
  const statusEl = document.getElementById("integrityStatus");
  try {
    const res = await api("/ledger", { auth: state.apiKey });
    statusEl.className = `integrityBig ${res.chainValid ? "valid" : "invalid"}`;
    statusEl.textContent = res.chainValid ? "✓ HASH CHAIN VERIFIED" : "✗ INTEGRITY VIOLATION DETECTED";
    return res;
  } catch (err) {
    statusEl.className = "integrityBig invalid";
    statusEl.textContent = "✗ " + err.message;
    return null;
  }
}

async function tamperLatestEntry() {
  const explainEl = document.getElementById("integrityExplain");
  explainEl.textContent = "";
  try {
    const ledgerRes = await api("/ledger", { auth: state.apiKey });
    const entries = ledgerRes.entries;
    if (!entries || entries.length === 0) {
      explainEl.textContent = "No ledger entries yet to tamper with — create an agent or run a transaction first.";
      return;
    }
    const latest = entries[entries.length - 1];
    await api(`/demo/tamper-ledger-entry/${latest.seq}`, { method: "POST", auth: state.apiKey });
    const after = await checkIntegrity();
    explainEl.textContent =
      `Entry #${latest.seq} (${latest.kind}) was altered directly in storage, bypassing Aegis entirely — its content ` +
      `hash and signature were computed over the ORIGINAL content and were never recomputed.` +
      (after && !after.chainValid ? " verifyChain() detected the mismatch immediately, at exactly that entry." : "");
  } catch (err) {
    explainEl.textContent = `Tamper failed: ${err.message}`;
  }
}

document.getElementById("attackNewMissionBtn").addEventListener("click", attackCreateMission);
document.getElementById("attackLaunchBtn").addEventListener("click", async () => {
  const btn = document.getElementById("attackLaunchBtn");
  btn.disabled = true;
  try {
    await launchBudgetAttack();
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("revocationRunBtn").addEventListener("click", runRevocationScenario);
document.getElementById("integrityCheckBtn").addEventListener("click", checkIntegrity);
document.getElementById("integrityTamperBtn").addEventListener("click", tamperLatestEntry);

(function init() {
  const apiKey = localStorage.getItem(LS_KEYS.apiKey);
  const principalId = localStorage.getItem(LS_KEYS.principalId);
  if (apiKey && principalId) {
    state.apiKey = apiKey;
    state.principalId = principalId;
    boot();
  }
})();
