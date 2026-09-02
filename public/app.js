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
  viewingMission: null, // the full mission object last fetched by viewMissionDetail(), or null — read by renderAuthorityFlow() to extend the flow with the mission's budget, only when it belongs to the active agent.
  activeWorkspace: "Overview",
  lastDecision: null, // { verdict, reason } from the most recent real Simulate/Execute response — read by renderOverview(), never re-derived.
};

// ---------- Block 4A: one-time "moment of truth" success pulse ----------
// Tracks whether each specific moment-of-truth box has EVER shown a genuine success
// on this page load — the pulse (see .integrityBig.pulse in index.html) fires only
// the first time, never on every re-check/re-run, so it stays a real moment instead
// of becoming background noise. Denial states get no equivalent animation at all —
// see checkIntegrity()/launchBudgetAttack() below.
let integrityPulsedOnce = false;
let attackZeroOverspendPulsedOnce = false;

// ---------- Block 4A: mission remaining-budget count-up ----------
// The single most important number during the mission/race section. Tweens ONLY
// when re-rendering the SAME mission with a value that has genuinely changed (e.g.
// after a real transaction settles) — a first-ever view of a mission, or switching
// to a DIFFERENT mission, always renders the real number immediately/statically,
// never tweening between two unrelated missions' unrelated budgets. Every
// intermediate frame is a pure display interpolation between two real,
// already-server-confirmed endpoints — never an invented value — and always lands
// exactly on the true final figure. Falls back to an immediate, static render
// wherever requestAnimationFrame isn't available (e.g. the node:vm dashboard-test
// sandbox), so this can never throw or hang a test, and can never show a wrong
// number even transiently in an environment that can't animate at all.
let lastMissionBudgetShown = null; // { missionId, remainingMinorUnits, currency }
let missionBudgetTweenToken = 0;

function renderBudgetHeroLine(el_, remainingMinorUnits, currency) {
  el_.textContent = `${fmtMoney(remainingMinorUnits, currency)} remaining`;
}

function tweenBudgetHeroLine(el_, fromMinorUnits, toMinorUnits, currency, durationMs = 450) {
  if (typeof requestAnimationFrame !== "function") {
    renderBudgetHeroLine(el_, toMinorUnits, currency);
    return;
  }
  const myToken = ++missionBudgetTweenToken;
  const start = Date.now();
  const step = () => {
    if (myToken !== missionBudgetTweenToken) return; // superseded by a newer render — abandon this tween, never fight over the DOM
    const elapsed = Date.now() - start;
    const t = Math.min(1, elapsed / durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const current = Math.round(fromMinorUnits + (toMinorUnits - fromMinorUnits) * eased);
    renderBudgetHeroLine(el_, current, currency);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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

// ---------- Block 4A: unified motion/state system ----------
// ONE reusable stagger primitive, reused by the pipeline trace, the attack-theatre
// trace, and Authority Flow — never a separate animation system per region. Every
// element passed here has ALREADY been appended to its real, final DOM position by
// the caller (structure/timing is fully synchronous, matching every other render
// function in this file) — this only adds a CSS class + an inline animation-delay,
// so the node:vm-based dashboard tests (which never execute CSS/animations at all)
// see an identical final DOM to before this existed.
/**
 * A brief, extremely faint whole-page tint toward the real allow/deny color —
 * background atmosphere responding to an actual moment of truth, never a fabricated
 * one. Called only at the same three real verdict points this file already treats as
 * "moment of truth" elsewhere (a live Execute, a ledger verify, an attack's final
 * server-confirmed overspend check) — never for historical/replayed results, never
 * per attack-attempt row. Avoids classList (not present on the fake DOM the
 * node:vm-based dashboard tests use) and feature-detects setTimeout the same way
 * scheduleReveal() does, so this can never throw in that sandbox — it just leaves the
 * tint in its last state, which no test asserts on.
 */
let bgPulseToken = 0;
function pulseAtmosphere(kind) {
  const el_ = document.getElementById("bgPulse");
  if (!el_) return;
  const myToken = ++bgPulseToken;
  el_.style.color = kind === "deny" ? "var(--deny)" : kind === "escalate" ? "var(--escalate)" : "var(--allow)";
  el_.className = "show";
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      // Same stale-timer guard as envSignalTo() below — several real "moment of
      // truth" events within 900ms of each other must never let an earlier one's
      // timer erase a later one's still-fresh tint.
      if (myToken === bgPulseToken) el_.className = "";
    }, 900);
  }
}

function staggerReveal(elements, stepMs = 150) {
  let i = 0;
  for (const elem of elements) {
    if (!elem || elem.nodeType === 3) continue; // skip text nodes / falsy entries
    elem.className = elem.className ? `${elem.className} reveal` : "reveal";
    elem.style.animationDelay = `${i * stepMs}ms`;
    i++;
  }
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
  // Block 4B: same reusable stagger as everywhere else, just snappier — a tree can
  // have many nodes and this should read as "settled quickly", not a slow cascade.
  staggerReveal(container.childNodes, 60);
}

function renderAgentNode(agent, depth) {
  const isRoot = depth === 0;
  // Block 4B: root vs delegated gets its own left-border color (the same
  // hierarchy/status vocabulary .stage-*/`.chainNode` already use elsewhere) and the
  // SAME role label Authority Flow already uses for the identical distinction — the
  // tree answers "who delegated to whom", Authority Flow answers "what authority was
  // actually inherited/narrowed", using consistent wording between the two.
  const node = el("div", { class: `agentNode ${isRoot ? "root" : "delegated"}${agent.agentId === state.activeAgentId ? " active" : ""}` });
  node.style.marginLeft = `${depth * 14}px`;

  const hasToken = Boolean(loadTokens()[agent.agentId]);
  node.appendChild(el("div", { class: "chainRole", text: isRoot ? "Agent authority" : "Delegated (attenuated)" }));
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
  state.viewingMissionId = null;
  state.viewingMission = null;
  document.getElementById("activeAgentLabel").textContent = agentId;
  renderAgentTree();
  populateTxMissionSelect();
  renderAuthorityFlow();
}

// ---------- authority flow (Step "Day 1, Block 1") ----------
// A first-class visualization of the one idea the rest of the dashboard only implies:
// authority narrows at every level and never widens. Built entirely from data already
// held in `state` (agent caveats + parent links already come back on every /agents
// list, and the last mission fetched by viewMissionDetail()) — no new API calls.
// Reuses the exact chain/tagline visual vocabulary already proven in the Scenario B/D
// attack-theatre panel (.chainFlow/.chainNode/.chainArrow/.narrowTagline), so this adds
// no new colors, no new motion, no new visual language — only a new place it appears.

/** Root-to-selected-agent lineage, built from state.agents' own parentAgentId links — never re-fetched. */
function authorityLineage(agentId) {
  const byId = new Map(state.agents.map((a) => [a.agentId, a]));
  const lineage = [];
  let current = byId.get(agentId);
  while (current) {
    lineage.unshift(current);
    current = current.parentAgentId ? byId.get(current.parentAgentId) : undefined;
  }
  return lineage;
}

/** `heroId`, when true, renders idText at the hero type scale — used only for the LIVE BUDGET stage's headline figure, the single most important number in the flow. Every other stage keeps its existing, unchanged size. */
function authorityStage(role, idText, detailText, heroId, diffText) {
  const node = el("div", { class: "chainNode" });
  node.appendChild(
    el("div", { class: "chainTop" }, [el("span", { class: "chainRole", text: role })])
  );
  node.appendChild(el("div", { class: heroId ? "heroLine" : "chainId", text: idText }));
  node.appendChild(el("div", { class: "chainCaveats", text: detailText }));
  if (diffText) node.appendChild(el("div", { class: "narrowDiff", text: diffText }));
  return node;
}

/**
 * What narrowed between a parent's caveats and its immediate child's — computed
 * ONLY from the two real caveat objects already held in state (never re-derived,
 * never invented). Returns null when there's nothing to show (a legally equal-bounds
 * attenuation narrows nothing). amountDelta is only included when strictly positive
 * — validateAttenuation never permits a widening, so this can never be negative.
 */
function computeCaveatDiff(parentCaveats, childCaveats) {
  const amountDelta = parentCaveats.maxAmountMinorUnits - childCaveats.maxAmountMinorUnits;
  const removedCategories = parentCaveats.categories.filter((c) => !childCaveats.categories.includes(c));
  const removedRails = parentCaveats.rails.filter((r) => !childCaveats.rails.includes(r));
  if (amountDelta <= 0 && removedCategories.length === 0 && removedRails.length === 0) return null;
  const parts = [];
  if (amountDelta > 0) parts.push(`-${fmtMoney(amountDelta, childCaveats.currency)}`);
  for (const c of removedCategories) parts.push(`-${c}`);
  for (const r of removedRails) parts.push(`-${r}`);
  return parts.join(" · ");
}

function renderAuthorityFlow() {
  const container = document.getElementById("graphView");
  container.innerHTML = "";

  if (!state.activeAgentId) {
    container.appendChild(el("div", { class: "hint", text: "Select an agent to see how far its authority reaches — and where it narrows." }));
    return;
  }

  const lineage = authorityLineage(state.activeAgentId);
  if (lineage.length === 0) {
    container.appendChild(el("div", { class: "hint", text: "Loading…" }));
    return;
  }

  const flow = el("div", { class: "chainFlow" });
  lineage.forEach((agent, i) => {
    if (i > 0) flow.appendChild(el("div", { class: "chainArrow", text: "↓" }));
    const role = i === 0 ? "Agent authority" : "Delegated (attenuated)";
    const idText = agent.agentId + (agent.agentId === state.activeAgentId && lineage.length > 1 ? " (selected)" : "");
    const detail = `cap ${fmtMoney(agent.caveats.maxAmountMinorUnits, agent.caveats.currency)} · ${agent.caveats.categories.join(",")} · ${agent.caveats.rails.join(",")}`;
    // What narrowed at exactly this step, versus its immediate parent — computed
    // only from the two real caveat objects already in the lineage, never invented.
    const diffText = i > 0 ? computeCaveatDiff(lineage[i - 1].caveats, agent.caveats) : null;
    flow.appendChild(authorityStage(role, idText, detail, false, diffText));
  });

  const mission = state.viewingMission;
  if (mission && mission.agentId === state.activeAgentId) {
    flow.appendChild(el("div", { class: "chainArrow", text: "↓" }));
    flow.appendChild(
      authorityStage(
        "Mission boundary",
        mission.missionId,
        `budget ${fmtMoney(mission.budgetMinorUnits, mission.currency)} · ${mission.allowedCategories ? mission.allowedCategories.join(",") : "(same as agent token)"} · ${mission.approvedCounterparties ? mission.approvedCounterparties.join(",") : "(unrestricted)"}`
      )
    );
    flow.appendChild(el("div", { class: "chainArrow", text: "↓" }));
    flow.appendChild(
      authorityStage(
        "Live budget",
        `${fmtMoney(mission.remainingMinorUnits, mission.currency)} remaining`,
        `spent ${fmtMoney(mission.spentMinorUnits, mission.currency)} · reserved ${fmtMoney(mission.reservedMinorUnits, mission.currency)} · of ${fmtMoney(mission.budgetMinorUnits, mission.currency)} budget`,
        true
      )
    );
  }

  container.appendChild(flow);
  const tagline = el("div", { class: "narrowTagline" }, [
    el("span", { class: "can", text: "AUTHORITY CAN NARROW" }),
    document.createTextNode(" · "),
    el("span", { class: "cannot", text: "AUTHORITY CANNOT WIDEN" }),
  ]);
  container.appendChild(tagline);
  // Same reusable stagger as the pipeline trace — narrows visually cascade downward
  // in the same order the real caveats actually narrow, ending on the tagline.
  staggerReveal([...flow.childNodes, tagline]);
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
// options.txSummary: { amountMinorUnits, currency, category, counterparty } — the
// exact real values this specific attempt was submitted with. For a live
// Simulate/Execute click these come straight from the form fields that were just
// submitted (see the click handlers below); for a historical mission entry they come
// straight from that entry's own ledger data (see historyEventToDecisionBody) — never
// invented, never re-derived from anything else.
function renderDecisionResult(container, body, options = {}) {
  container.innerHTML = ""; // clearing only — never used to insert untrusted content
  if (!body) return;
  const { decision, execution } = body;
  const missionLabel = options.missionId ? `Mission (${options.missionId})` : "Mission";

  // The verdict is the answer; the context line under it is what was actually
  // submitted; the pipeline below is the evidence for the verdict. Reading top to
  // bottom: what happened, to what, why — without narration.
  const top = el("div", { class: "verdictLine" }, [verdictBadge(decision.verdict), el("span", { text: " " + decision.reason })]);
  container.appendChild(top);

  if (options.txSummary) {
    const s = options.txSummary;
    container.appendChild(
      el("div", { class: "txContext" }, [
        document.createTextNode(`${fmtMoney(s.amountMinorUnits, s.currency)} · ${s.category} · ${s.counterparty}`),
      ])
    );
  }

  const pipeline = el("div", { class: "pipeline" });

  if (decision.source === "mission") {
    // The mission gate denied this attempt before capability/policy/risk/execution
    // ever ran — nothing downstream exists to show.
    pipeline.appendChild(pipelineStage(missionLabel, "deny", [el("span", { text: decision.reason })]));
    container.appendChild(pipeline);
    staggerReveal(pipeline.childNodes);
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
  // Presentation only — every stage above was already appended synchronously, in the
  // real, unmodified order the pipeline actually ran in; this only staggers how fast
  // they visually fade in, ~150ms apart, so a viewer watches the request travel
  // through the pipeline instead of seeing a wall of text appear at once.
  staggerReveal(pipeline.childNodes);
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
  const txn = currentTransaction();
  try {
    const body = { transaction: txn };
    if (missionId) {
      body.missionId = missionId;
      body.counterparty = counterparty; // required by /simulate only when a mission is attached
    }
    const res = await api("/simulate", { method: "POST", auth: token, body });
    if (requestId !== latestResultRequestId) return; // a newer Simulate/Execute click has since started — this response is stale
    const txSummary = { amountMinorUnits: txn.amountMinorUnits, currency: txn.currency, category: txn.category, counterparty };
    renderDecisionResult(resultEl, res, { missionUsed: Boolean(missionId), missionId, txSummary });
    state.lastDecision = { verdict: res.decision.verdict, reason: res.decision.reason };
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
  const txn = currentTransaction();
  try {
    const body = { transaction: txn, counterparty };
    if (missionId) body.missionId = missionId;
    const res = await api("/transactions", {
      method: "POST",
      auth: token,
      headers: { "idempotency-key": crypto.randomUUID() },
      body,
    });
    if (requestId !== latestResultRequestId) return; // a newer Simulate/Execute click has since started — this response is stale
    const txSummary = { amountMinorUnits: txn.amountMinorUnits, currency: txn.currency, category: txn.category, counterparty };
    renderDecisionResult(resultEl, res, { missionUsed: Boolean(missionId), missionId, txSummary });
    state.lastDecision = { verdict: res.decision.verdict, reason: res.decision.reason };
    // A real execute (not a Simulate dry-run) is one of the three moments this file
    // treats as "moment of truth" — see pulseAtmosphere()'s own doc comment. The
    // environment glow reacts to the real verdict the pipeline actually reached —
    // see decisionReachFraction()'s comment for exactly how that's derived (allow,
    // deny, or the real escalate verdict the risk stage can genuinely return).
    const reach = decisionReachFraction(res);
    pulseAtmosphere(reach.kind);
    envSignalTo(reach.fraction, reach.kind);
    if (missionId) await loadMissions(); // refresh budget/spent/reserved figures after a mission-scoped attempt — always reflects real server state, independent of #result staleness
    refreshLedger(); // keeps the shell's status chip and the Evidence workspace honest after a real state change, not just after boot or an explicit Refresh click
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

/**
 * The optional Mission dropdown on the transaction form only ever offers ACTIVE
 * missions belonging to the currently selected agent — an agent can't accidentally
 * submit against another agent's mission or a closed one from the UI (the API
 * enforces this regardless; this is just not offering a doomed option).
 *
 * Preserves the current selection across a rebuild (same pattern as
 * populateMissionAgentSelect() above) — this select is rebuilt after every
 * mission-scoped transaction (see the executeBtn handler's loadMissions() call), and
 * without this a rebuilt <select> silently defaults back to its first option
 * ("None"), which used to make a second transaction against the same mission
 * require re-selecting it by hand. Only restores the value if it's STILL a real,
 * active mission belonging to the currently active agent — never blindly restores a
 * stale selection.
 */
function populateTxMissionSelect() {
  const select = document.getElementById("txMission");
  const previous = select.value;
  select.innerHTML = "";
  select.appendChild(el("option", { value: "", text: "None — use the agent's standing authority" }));
  for (const m of state.missions) {
    if (m.agentId !== state.activeAgentId || m.status !== "active") continue;
    select.appendChild(el("option", { value: m.missionId, text: `${m.missionId} — ${m.goal.slice(0, 60)}` }));
  }
  if (state.missions.some((m) => m.missionId === previous && m.agentId === state.activeAgentId && m.status === "active")) {
    select.value = previous;
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

/**
 * The real submitted amount/category/counterparty for one history entry — read
 * directly from that entry's own ledger data, never invented. The two mission-tagged
 * kinds carry this differently (mission_policy_verdict nests a full `transaction`
 * object with its own currency; mission_pipeline_outcome carries these fields flat,
 * with no currency field of its own — see src/mission/ledger.ts's
 * MissionPipelineOutcomeData), so `missionCurrency` (the containing mission's own
 * real currency, already known by the caller) is the correct, real source for that
 * one case, not a guess.
 */
function historyEventToTxSummary(event, missionCurrency) {
  const d = event.data;
  if (event.kind === "mission_policy_verdict") {
    // Every entry the real server writes includes `transaction`/`counterparty` here
    // (see routes/transactions.ts) — this guard is defense-in-depth only, so an
    // unexpected/malformed entry degrades to "no context line" rather than crashing
    // the whole mission detail view, matching this codebase's fail-safe-not-crash
    // posture elsewhere (e.g. the verifier's own malformed-entry handling).
    if (!d.transaction) return null;
    return { amountMinorUnits: d.transaction.amountMinorUnits, currency: d.transaction.currency, category: d.transaction.category, counterparty: d.counterparty };
  }
  return { amountMinorUnits: d.amountMinorUnits, currency: missionCurrency, category: d.category, counterparty: d.counterparty };
}

function renderMissionHistoryEntry(missionId, missionCurrency, event) {
  const wrapper = el("div", { class: "card" });
  wrapper.appendChild(el("div", { class: "top" }, [el("span", { class: "kind", text: `#${event.seq}` }), el("span", { class: "time", text: fmtTime(event.createdAt) })]));
  const body = el("div", {});
  wrapper.appendChild(body);
  renderDecisionResult(body, historyEventToDecisionBody(event), { missionUsed: true, missionId, txSummary: historyEventToTxSummary(event, missionCurrency) });
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
    state.viewingMission = mission;
    renderAuthorityFlow();
  } catch (err) {
    renderError(container, err.message);
  }
}

function renderMissionDetail(mission, ledgerEntries) {
  const container = document.getElementById("missionDetail");
  container.innerHTML = "";

  container.appendChild(el("h3", { text: mission.missionId }));
  // Identity right under the mission's own name — who owns it, what state it's in
  // — before anything about its objective or its money, matching the same
  // "identity, then constraints" order the rest of the app already uses (an agent
  // card shows its own id before its caveats; a transaction result shows the
  // verdict before the pipeline that produced it).
  container.appendChild(
    el("div", { class: "missionIdentityLine" }, [
      el("span", { class: `badge ${statusBadgeClass(mission.status)}`, text: mission.status }),
      document.createTextNode(" "),
      el("span", { class: "missionAgentRef", text: mission.agentId }),
    ])
  );
  container.appendChild(el("div", { class: "goal", text: mission.goal }));

  // Block 4B: the budget picture (the number the whole race/attack story is about)
  // gets its own visually distinct block, separate from static configuration below —
  // MISSION -> PURPOSE -> AUTHORITY BOUNDARY -> BUDGET/SPEND/REMAINING, with
  // REMAINING staying the dominant figure exactly as before (Block 3B's .heroLine).
  const budgetBlock = el("div", { class: "missionBudgetBlock" });
  const heroLineEl = el("div", { class: "heroLine" });
  budgetBlock.appendChild(heroLineEl);
  // Block 4A: tween only when re-rendering the SAME mission with a genuinely
  // different value (e.g. a transaction just settled against it) — a first-ever
  // view, or an unchanged value, always renders immediately/statically.
  if (
    lastMissionBudgetShown &&
    lastMissionBudgetShown.missionId === mission.missionId &&
    lastMissionBudgetShown.remainingMinorUnits !== mission.remainingMinorUnits
  ) {
    tweenBudgetHeroLine(heroLineEl, lastMissionBudgetShown.remainingMinorUnits, mission.remainingMinorUnits, mission.currency);
  } else {
    renderBudgetHeroLine(heroLineEl, mission.remainingMinorUnits, mission.currency);
  }
  lastMissionBudgetShown = { missionId: mission.missionId, remainingMinorUnits: mission.remainingMinorUnits, currency: mission.currency };
  // Spelled-out arithmetic, not just the final figure — the same three real numbers
  // the hero line and the fill bar already use (budget, settled, reserved), just
  // shown as the actual subtraction rather than a single dense sentence.
  const mathLine = el("div", { class: "budgetMath" });
  mathLine.appendChild(document.createTextNode(fmtMoney(mission.budgetMinorUnits, mission.currency)));
  mathLine.appendChild(el("span", { class: "op", text: " budget " }));
  mathLine.appendChild(el("span", { class: "op", text: "− " }));
  mathLine.appendChild(document.createTextNode(fmtMoney(mission.spentMinorUnits, mission.currency)));
  mathLine.appendChild(el("span", { class: "op", text: " settled" }));
  if (mission.reservedMinorUnits > 0) {
    mathLine.appendChild(el("span", { class: "op", text: " − " }));
    mathLine.appendChild(document.createTextNode(fmtMoney(mission.reservedMinorUnits, mission.currency)));
    mathLine.appendChild(el("span", { class: "op", text: " reserved" }));
  }
  mathLine.appendChild(el("span", { class: "op", text: " = " }));
  mathLine.appendChild(document.createTextNode(`${fmtMoney(mission.remainingMinorUnits, mission.currency)} remaining`));
  budgetBlock.appendChild(mathLine);
  // A real, non-decorative fill — the same .budgetBar component the attack theatre
  // already uses, driven by this mission's own real committed spend (settled +
  // reserved) against its own real budget. Never a second, invented figure.
  const committedMinorUnits = mission.spentMinorUnits + mission.reservedMinorUnits;
  const barPct = mission.budgetMinorUnits > 0 ? Math.min(100, (committedMinorUnits / mission.budgetMinorUnits) * 100) : 0;
  const barFill = el("div", { class: committedMinorUnits > mission.budgetMinorUnits ? "fill overspend" : "fill" });
  barFill.style.width = `${barPct}%`;
  budgetBlock.appendChild(el("div", { class: "budgetBar" }, [barFill]));
  container.appendChild(budgetBlock);

  container.appendChild(
    el("div", { class: "missionAuthorityLine" }, [
      el("span", { class: "chainRole", text: "Authority boundary" }),
      document.createElement("br"),
      document.createTextNode(`categories: ${mission.allowedCategories ? mission.allowedCategories.join(", ") : "(same as agent token)"}`),
      document.createElement("br"),
      document.createTextNode(`approved counterparties: ${mission.approvedCounterparties ? mission.approvedCounterparties.join(", ") : "(unrestricted)"}`),
    ])
  );
  container.appendChild(el("div", { class: "hint", text: `expires ${new Date(mission.expiresAt).toLocaleString()}` }));

  const historyContainer = el("div", { id: "missionHistory" });
  const history = selectMissionHistoryEvents(ledgerEntries, mission.missionId);
  if (history.length === 0) {
    historyContainer.appendChild(el("div", { class: "hint", text: "No transactions attempted under this mission yet." }));
  } else {
    for (const event of history) historyContainer.appendChild(renderMissionHistoryEntry(mission.missionId, mission.currency, event));
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
      if (entry.signature) row.appendChild(el("div", { class: "hash", text: `sig ${truncHash(entry.signature)}` }));
      listEl.appendChild(row);
    }
    updateShellStatus(res.chainValid, res.entries.length);
  } catch (err) {
    statusEl.className = "invalid";
    statusEl.textContent = err.message;
    updateShellStatus(false, null);
  }
}

/** Mirrors the ledger's own real, just-fetched status into the persistent shell's
 * small status chip — never a second, independently-computed value. */
function updateShellStatus(chainValid, entryCount) {
  const chip = document.getElementById("shellStatus");
  const text = document.getElementById("shellStatusText");
  if (!chip || !text) return;
  chip.className = `shellStatus ${chainValid ? "valid" : "invalid"}`;
  text.textContent = chainValid ? `Ledger verified${entryCount != null ? ` · ${entryCount}` : ""}` : "Ledger tampered";
}

// ---------- workspaces (Block 6) ----------
// A persistent shell around six named workspaces. Every workspace reuses the exact
// same elements and render functions that previously sat on one long page — this
// only changes which of them is currently visible, never what they show or how they
// compute it. Looked up purely by fixed element id (never querySelectorAll/dataset),
// matching every other DOM access in this file and staying safe inside the node:vm
// dashboard-test sandbox, whose fake document only implements getElementById.

const WORKSPACES = ["Overview", "Authority", "Missions", "Transactions", "Security", "Evidence"];

function showWorkspace(name) {
  const normalized = WORKSPACES.find((w) => w.toLowerCase() === String(name).toLowerCase()) || "Overview";
  for (const w of WORKSPACES) {
    const section = document.getElementById(`ws${w}`);
    const navBtn = document.getElementById(`nav${w}`);
    if (section) section.className = w === normalized ? "workspace active" : "workspace";
    if (navBtn) navBtn.className = w === normalized ? "navBtn active" : "navBtn";
  }
  state.activeWorkspace = normalized;
  if (normalized === "Overview") renderOverview();
  envWorkspaceShift(normalized);
}

function initWorkspaceNav() {
  for (const w of WORKSPACES) {
    const btn = document.getElementById(`nav${w}`);
    if (btn) btn.addEventListener("click", () => showWorkspace(w));
  }
  // Overview's facts are entry points, not dead ends — clicking one takes you to the
  // workspace that actually owns that data.
  const gotoMap = { ovGotoAuthority: "Authority", ovGotoMission: "Missions", ovGotoBudget: "Missions", ovGotoDecision: "Transactions", ovGotoLedger: "Evidence" };
  for (const [id, target] of Object.entries(gotoMap)) {
    const target_ = document.getElementById(id);
    if (target_) target_.addEventListener("click", () => showWorkspace(target));
  }
}

/**
 * Progressive-disclosure "ⓘ" controls (public/index.html's .infoControl/.infoBtn/
 * .infoPopover) — a short line stays permanently visible in the markup; clicking,
 * tapping, or keyboard-focusing the button next to it reveals the fuller
 * explanation. Hover works too, for free, via CSS (:hover/:focus-within) — this
 * function only handles the parts CSS can't: click/tap toggling a *persistent* open
 * state (so touch users aren't relying on hover at all), closing other open
 * popovers when a new one opens, closing on outside click or Escape, and nudging a
 * popover that would run off the right edge of the viewport back on-screen.
 *
 * Only called from boot() — never at module load time — so it's safe to use
 * document.querySelectorAll/addEventListener here even though the node:vm
 * dashboard-test sandbox's fake document doesn't implement them; boot() is never
 * invoked in that sandbox (confirmed: it only runs after a real sign-in, and the
 * tests never simulate one). The typeof guards below are extra insurance, not the
 * primary safety mechanism.
 */
function initInfoControls() {
  if (typeof document.querySelectorAll !== "function" || typeof document.addEventListener !== "function") return;

  const openControls = () => Array.from(document.querySelectorAll(".infoControl.open"));
  const closeControl = (control) => {
    control.className = control.className.replace(/\bopen\b/, "").trim();
    const btn = control.querySelector(".infoBtn");
    if (btn) btn.setAttribute("aria-expanded", "false");
  };
  const positionPopover = (control) => {
    const popover = control.querySelector(".infoPopover");
    if (!popover || typeof popover.getBoundingClientRect !== "function") return;
    popover.className = popover.className.replace(/\bflip-right\b/, "").trim();
    const rect = popover.getBoundingClientRect();
    if (typeof window !== "undefined" && rect.right > window.innerWidth - 12) {
      popover.className = `${popover.className} flip-right`.trim();
    }
  };

  document.addEventListener(
    "focusin",
    (evt) => {
      const control = evt.target.closest ? evt.target.closest(".infoControl") : null;
      if (control) positionPopover(control);
    },
    true
  );
  // mouseover (bubbles) rather than mouseenter (doesn't) so one delegated listener
  // covers every current and future .infoControl — the hover reveal itself is pure
  // CSS (:hover), this only makes sure a hover-revealed popover near the right edge
  // gets the same off-screen correction the click/focus paths already get.
  document.addEventListener("mouseover", (evt) => {
    const control = evt.target.closest ? evt.target.closest(".infoControl") : null;
    if (control) positionPopover(control);
  });

  document.addEventListener("click", (evt) => {
    const btn = evt.target.closest ? evt.target.closest(".infoBtn") : null;
    if (btn) {
      evt.preventDefault();
      const control = btn.closest(".infoControl");
      if (!control) return;
      const isOpen = / open(\s|$)/.test(` ${control.className} `);
      for (const other of openControls()) if (other !== control) closeControl(other);
      if (isOpen) {
        closeControl(control);
      } else {
        control.className = `${control.className} open`.trim();
        btn.setAttribute("aria-expanded", "true");
        positionPopover(control);
      }
      return;
    }
    // A click anywhere else (including inside an open popover's own text) closes
    // any popover that was opened by click/tap rather than by hover.
    if (!evt.target.closest || !evt.target.closest(".infoPopover")) {
      for (const other of openControls()) closeControl(other);
    }
  });

  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") {
      for (const control of openControls()) closeControl(control);
    }
  });
}

/**
 * A small set of real facts pulled from state already populated elsewhere
 * (loadAgents/loadMissions/simulate-execute) — never a second, independent fetch
 * that could disagree with what the owning workspace shows. Ledger integrity is the
 * one exception worth calling out: it mirrors refreshLedger()'s own just-fetched
 * #chainStatus text/class rather than re-deriving anything, so Overview and Evidence
 * can never show two different answers to the same real question.
 */
function renderOverview() {
  const agent = state.agents.find((a) => a.agentId === state.activeAgentId);
  const ovAuthority = document.getElementById("ovAuthority");
  const ovAuthorityDetail = document.getElementById("ovAuthorityDetail");
  if (agent) {
    ovAuthority.textContent = agent.agentId;
    ovAuthorityDetail.textContent = `cap ${fmtMoney(agent.caveats.maxAmountMinorUnits, agent.caveats.currency)} · ${agent.caveats.categories.join(",")}`;
  } else {
    ovAuthority.textContent = "No agent selected";
    ovAuthorityDetail.textContent = "";
  }

  const mission = state.viewingMission || state.missions.find((m) => m.status === "active");
  const ovMission = document.getElementById("ovMission");
  const ovMissionDetail = document.getElementById("ovMissionDetail");
  const ovBudget = document.getElementById("ovBudget");
  if (mission) {
    ovMission.textContent = mission.missionId;
    ovMissionDetail.textContent = mission.goal;
    ovBudget.textContent = `${fmtMoney(mission.remainingMinorUnits, mission.currency)} remaining of ${fmtMoney(mission.budgetMinorUnits, mission.currency)}`;
  } else {
    ovMission.textContent = "No mission selected";
    ovMissionDetail.textContent = "";
    ovBudget.textContent = "—";
  }

  const ovDecision = document.getElementById("ovDecision");
  const ovDecisionDetail = document.getElementById("ovDecisionDetail");
  if (state.lastDecision) {
    ovDecision.textContent = state.lastDecision.verdict;
    ovDecision.className = `factValue ${state.lastDecision.verdict === "allow" ? "allow" : state.lastDecision.verdict === "deny" ? "deny" : ""}`;
    ovDecisionDetail.textContent = state.lastDecision.reason || "";
  } else {
    ovDecision.textContent = "No transaction submitted yet";
    ovDecision.className = "factValue";
    ovDecisionDetail.textContent = "";
  }

  const ovLedger = document.getElementById("ovLedger");
  const chainStatus = document.getElementById("chainStatus");
  if (chainStatus && chainStatus.textContent && chainStatus.textContent !== "—") {
    const valid = chainStatus.className === "valid";
    ovLedger.textContent = valid ? "Verified" : "Tampered";
    ovLedger.className = `factValue ${valid ? "allow" : "deny"}`;
  } else {
    ovLedger.textContent = "—";
    ovLedger.className = "factValue";
  }
}

// ---------- environment ----------
// Six real photographs, one per workspace (public/assets/overview|authority|
// missions|transactions|security|evidence.png — see ENV_WORKSPACE_IMAGES below)
// behind the shell, crossfading between two stacked <img> layers as the active
// workspace changes — see index.html's #environment comment for the full layer
// stack. Every function below is presentation-only, touches only plain DOM
// properties (no SVG-specific methods), and feature-detects setTimeout/
// requestAnimationFrame/window exactly like pulseAtmosphere()/staggerReveal()
// already do, so none of it can throw in the node:vm dashboard-test sandbox.

/**
 * Fraction of the pipeline a real decision actually reached, derived from the exact
 * same branching renderDecisionResult() already uses — never a separate guess, and
 * never further than execution actually got. Still used to choose allow/deny for the
 * environment's reaction, even though the photo has no discrete "path" to animate a
 * distance along.
 */
function decisionReachFraction(body) {
  const { decision, execution } = body;
  if (decision.source === "mission") return { fraction: 0.2, kind: "deny" };
  if (decision.policy && !decision.policy.allowed) return { fraction: 0.45, kind: "deny" };
  if (decision.verdict === "escalate") return { fraction: 0.7, kind: "escalate" };
  if (decision.verdict !== "allow") return { fraction: 0.7, kind: "deny" };
  if (execution && !execution.success) return { fraction: 0.9, kind: "deny" };
  return { fraction: 1, kind: "allow" };
}

// Shared by envSignalTo()/envBlip() below — both write #environmentSignal's
// className and clear it again after their own delay. Real rapid-fire events (e.g.
// several genuine Executes within a couple of seconds — exactly what happens right
// before a real rate-based risk escalation) can trigger several of these calls
// within each other's delay window; without a token guard, an EARLIER call's
// setTimeout fires later and unconditionally clears a LATER call's still-fresh
// state, cutting its glow short or erasing it outright. Found via a live stress
// test, not theoretical — a genuine ESCALATE's glow was being wiped by a stale
// timer from an earlier real DENY.
let envSignalToken = 0;

/** Brightens the environment's warm glow toward the real verdict color, then fades —
 * called from the same real "moment of truth" sites pulseAtmosphere() already uses
 * (a real Execute, a real ledger verify, a real revocation denial, the attack
 * theatre's final server-confirmed check). */
function envSignalTo(fraction, kind) {
  const signal = document.getElementById("environmentSignal");
  if (!signal) return;
  const myToken = ++envSignalToken;
  signal.className = kind === "deny" ? "pulse-deny" : kind === "escalate" ? "pulse-escalate" : "pulse-allow";
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      if (myToken === envSignalToken) signal.className = "";
    }, 1600);
  }
}

/** One real, small "blip" per real resolved attack attempt — never a count
 * independent of the real requests fireOne() actually fired. */
function envBlip() {
  const signal = document.getElementById("environmentSignal");
  if (!signal) return;
  const myToken = ++envSignalToken;
  signal.className = "blip";
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      if (myToken === envSignalToken) signal.className = "";
    }, 260);
  }
}

/** Shifts which part of the same photograph the "camera" favors when the workspace
 * changes — never a different image, never a hard cut (index.html's
 * #environment.workspace-shift rule shortens the transition slightly for a livelier
 * response to a deliberate navigation action vs. the slower ambient default). */
// One real photograph per workspace — six "rooms" of the same environment, not
// six crops of one source image. Keyed by the exact lowercase workspace name
// showWorkspace() already uses for its "ws-<name>" class.
const ENV_WORKSPACE_IMAGES = {
  overview: "/assets/overview.png",
  authority: "/assets/authority.png",
  missions: "/assets/missions.png",
  transactions: "/assets/transactions.png",
  security: "/assets/security.png",
  evidence: "/assets/evidence.png",
};

let envWorkspaceShiftToken = 0;
// Tracks which of the two stacked <img class="envImg"> layers is currently the
// visible ("active") one, so the next switch knows which is free to load into.
let envImageActiveIsA = true;

function envWorkspaceShift(workspaceName) {
  const env = document.getElementById("environment");
  if (!env) return;
  const myToken = ++envWorkspaceShiftToken;
  const key = String(workspaceName || "overview").toLowerCase();
  env.className = key === "overview" ? "workspace-shift" : `workspace-shift ws-${key}`;

  // Crossfade to the real photograph for this workspace. The currently-hidden
  // layer loads the new file; only once it has actually finished loading (never
  // on a blank/half-loaded frame) does it become .active and the old one fade out.
  // Never touches the transaction/decision/ledger logic this presentation sits on
  // top of — purely which of two <img> elements is visible.
  const src = ENV_WORKSPACE_IMAGES[key] || ENV_WORKSPACE_IMAGES.overview;
  const frontId = envImageActiveIsA ? "environmentImage" : "environmentImageB";
  const backId = envImageActiveIsA ? "environmentImageB" : "environmentImage";
  const front = document.getElementById(frontId);
  const back = document.getElementById(backId);
  if (front && back && front.getAttribute("src") !== src) {
    const swap = () => {
      if (myToken !== envWorkspaceShiftToken) return; // superseded by a newer switch — don't fight over which layer is active
      back.className = "envImg active";
      front.className = "envImg";
      envImageActiveIsA = !envImageActiveIsA;
    };
    if (back.getAttribute("src") === src && back.complete && back.naturalWidth > 0) {
      // back already holds this exact workspace's image, fully loaded — e.g.
      // bouncing between two recently-visited workspaces. Swap immediately; a
      // "load" listener would never fire for a src that isn't actually changing.
      swap();
    } else {
      if (typeof back.addEventListener === "function") back.addEventListener("load", swap, { once: true });
      back.src = src;
    }
  }

  if (typeof setTimeout === "function") {
    setTimeout(() => {
      // Guards against a quick double-click through two workspaces: the first
      // click's timer must not strip the transition class the second click just set.
      if (myToken === envWorkspaceShiftToken) {
        env.className = env.className.replace(/\bworkspace-shift\b/, "").trim();
      }
    }, 450);
  }
}

let envMouseHandlerAttached = false;
/**
 * Combined mouse parallax + scroll parallax + slow idle drift, all feeding the same
 * two CSS custom properties (--env-x/--env-y) that .envImg's transform (shared by
 * both workspace-image layers) already consumes, plus --env-scroll-y for the
 * separate scroll-only offset. Only
 * wired up in a real browser — `window` doesn't exist at all in the dashboard-test
 * sandbox, so this whole function is a no-op there rather than a crash (same
 * feature-detection discipline as every other env* function). Runs one continuous
 * requestAnimationFrame loop, but only writes to the DOM at ~10Hz (throttled by a
 * timestamp check) — idle drift needs a live loop, not just an event handler, but
 * there is no reason to touch style.setProperty 60 times a second for a layer this
 * subtle. Paused entirely while the tab is hidden.
 */
function initEnvironment() {
  if (envMouseHandlerAttached) return;
  envMouseHandlerAttached = true;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  if (!document.documentElement || typeof document.documentElement.style?.setProperty !== "function") return;
  if (typeof requestAnimationFrame !== "function") return;

  let mouseXRatio = 0;
  let mouseYRatio = 0;
  window.addEventListener("mousemove", (evt) => {
    mouseXRatio = evt.clientX / window.innerWidth - 0.5;
    mouseYRatio = evt.clientY / window.innerHeight - 0.5;
  });

  const startTime = Date.now();
  let lastApplied = 0;
  let running = true;
  let rafId = null;

  const tick = () => {
    if (!running) return;
    const now = Date.now();
    if (now - lastApplied >= 90) {
      lastApplied = now;
      const elapsedSec = (now - startTime) / 1000;
      // A slow, small wander so the environment never sits perfectly frozen even
      // with no input at all — kept small enough that combined with the mouse
      // offset below, the total stays within the ~8-16px "restrained parallax"
      // range, never a dramatic sway.
      const idleX = Math.sin(elapsedSec * 0.11) * 3;
      const idleY = Math.cos(elapsedSec * 0.07) * 2;
      const mouseX = mouseXRatio * -13;
      const mouseY = mouseYRatio * -9;
      const scrollY = Math.max(-20, Math.min(20, -(window.scrollY || 0) * 0.05));
      document.documentElement.style.setProperty("--env-x", (idleX + mouseX).toFixed(1));
      document.documentElement.style.setProperty("--env-y", (idleY + mouseY).toFixed(1));
      document.documentElement.style.setProperty("--env-scroll-y", scrollY.toFixed(1));
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        running = false;
        if (rafId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
      } else if (!running) {
        running = true;
        lastApplied = 0;
        rafId = requestAnimationFrame(tick);
      }
    });
  }
}

// ---------- boot ----------

function boot() {
  document.getElementById("authScreen").style.display = "none";
  document.getElementById("app").style.display = "block";
  document.getElementById("navBar").style.display = "flex";
  // The environment photograph leans in more strongly behind the sign-in screen
  // (see "body.pre-auth #environment"); once inside the real console it steps back
  // so it never competes with the density of actual data on screen.
  if (document.body && typeof document.body.className === "string") {
    document.body.className = document.body.className.replace(/\bpre-auth\b/, "").trim();
  }
  const badge = document.getElementById("principalBadge");
  badge.textContent = state.principalId + "  ";
  const logout = el("a", { class: "link", text: "switch principal" });
  logout.addEventListener("click", signOut);
  badge.appendChild(logout);

  initWorkspaceNav();
  initEnvironment();
  initInfoControls();
  checkDemoMode();
  loadAgents();
  loadMissions();
  refreshLedger();
  startStream();
  showWorkspace("overview");
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
    const prodNote = document.getElementById("securityProdNote");
    if (body.demoMode) {
      banner.textContent = "⚠ LOCAL DEMO MODE — deterministic judge / mock rail — no real money moves";
      banner.style.display = "block";
      theatre.style.display = "block";
      if (prodNote) prodNote.style.display = "none";
    } else {
      banner.style.display = "none";
      theatre.style.display = "none";
      if (prodNote) prodNote.style.display = "block";
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
const ATTACK_MISSION_BUDGET_MINOR_UNITS = 200_000; // matches attackCreateMission()'s own hardcoded mission budget below — named here so the budget-fill bar has a real denominator, not a second guess at it

// The button's label is derived directly from the SAME constants fireOne() uses to
// fire the real requests, at script-load time — not a second, independently-typed
// string. This is the actual fix for the stale "20 × $150" label that used to live
// in index.html: that string was never connected to ATTACK_AMOUNT_MINOR_UNITS at
// all, so it silently drifted out of sync with the real $380 amount every request
// actually uses. Deriving it here means it is now structurally impossible for the
// label to disagree with the request body again.
document.getElementById("attackLaunchBtn").textContent =
  `Launch attack (${ATTACK_ATTEMPT_COUNT} × $${(ATTACK_AMOUNT_MINOR_UNITS / 100).toFixed(0)})`;

// Block 4A: paces the VISUAL reveal of an already-real, already-resolved attempt's
// row flip only — never the request itself (the real fetch in fireOne() below is
// untouched and remains genuinely concurrent). setTimeout does not exist in the
// node:vm sandbox the dashboard tests run app.js in (only document/localStorage/
// fetch/console/crypto/confirm are provided there — see dashboard-attack-theatre.
// test.ts), so this feature-detects it and applies the real result immediately,
// synchronously, with no pacing at all, in that environment — the exact behavior
// this code had before Block 4A, and exactly what those tests already assert on.
function scheduleReveal(applyFn, delayMs) {
  if (typeof setTimeout === "function") {
    setTimeout(applyFn, delayMs);
  } else {
    applyFn();
  }
}

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
        budgetMinorUnits: ATTACK_MISSION_BUDGET_MINOR_UNITS,
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
  // Presentation only, driven by the SAME real counters.spendMinorUnits the stat
  // tile above already shows — never a second, independently-computed figure.
  const fillEl = document.getElementById("attackBudgetBarFill");
  const pct = Math.min(100, (counters.spendMinorUnits / ATTACK_MISSION_BUDGET_MINOR_UNITS) * 100);
  fillEl.style.width = `${pct}%`;
  fillEl.className = counters.spendMinorUnits > ATTACK_MISSION_BUDGET_MINOR_UNITS ? "fill overspend" : "fill";
}

// ---------- attack theatre pipeline trace (Block 3A) ----------
// Traces ONE real attempt's actual recorded response through the real pipeline,
// stage by stage, stopping exactly where that attempt's own response says it
// stopped — never a second, simulated attempt, never an assumed outcome. Reuses
// pipelineStage() (the same "stage" component already used for Simulate/Execute
// results and mission history — see renderDecisionResult() above) and
// .chainFlow/.chainArrow (already used for the revocation chain) — no new CSS, no
// new visual language.
//
// Real pipeline order note: the requested labeling was ATTACK -> CAPABILITY ->
// MISSION -> BUDGET -> DECISION -> EXECUTION -> LEDGER. The ACTUAL order, per
// src/api/routes/transactions.ts's runMissionPreflight, is: the mission gate
// (category/counterparty + atomic budget reservation) runs FIRST, entirely before
// capability verification, the risk engine, the decision, or execution ever start —
// a mission-gate denial means none of those later stages genuinely ran. This trace
// follows the real order, not the requested label order, because rendering a false
// sequence would itself be exactly the kind of "pretending later stages executed"
// this component exists to avoid. Mission+budget are shown as one stage (they are
// checked together, atomically, in one function call — splitting them would imply a
// false granularity); capability+policy are likewise shown as one stage, matching
// the exact "Capability & Policy" label pipelineStage() already uses elsewhere in
// this file for the identical real check.

/** Prefers a genuinely BLOCKED attempt — the actual point of this component is showing exactly where an attack is stopped, not just where it succeeds. Falls back to a real allowed attempt only if nothing was blocked. Never fabricates a record. */
function pickRepresentativeAttempt(records) {
  const blocked = records.find((r) => r && r.ok && r.response.decision && r.response.decision.verdict !== "allow");
  if (blocked) return blocked;
  const errored = records.find((r) => r && !r.ok);
  if (errored) return errored;
  return records.find((r) => r && r.ok) || null;
}

function buildAttackTraceStages(record, txInput) {
  const stages = [];
  stages.push(
    pipelineStage("Attack attempt", "gray", [
      document.createTextNode(`${fmtMoney(txInput.amountMinorUnits, txInput.currency)} · ${txInput.category} · ${txInput.counterparty}`),
    ])
  );
  if (!record) return stages;

  if (!record.ok) {
    stages.push(el("div", { class: "chainArrow", text: "↓" }));
    stages.push(pipelineStage("Request", "deny", [document.createTextNode(record.error)]));
    return stages;
  }

  const decision = record.response.decision;
  stages.push(el("div", { class: "chainArrow", text: "↓" }));
  if (decision.source === "mission") {
    stages.push(pipelineStage("Mission & budget gate", "deny", [document.createTextNode(decision.reason)]));
    return stages; // capability/risk/decision/execution genuinely never ran
  }
  stages.push(pipelineStage("Mission & budget gate", "allow", [document.createTextNode("Gate passed — budget reserved for this attempt")]));

  const policy = decision.policy;
  stages.push(el("div", { class: "chainArrow", text: "↓" }));
  stages.push(
    pipelineStage("Capability & policy", policy && policy.allowed ? "allow" : "deny", [
      document.createTextNode((policy && policy.reason) || (policy && policy.allowed ? "All capability-token caveats satisfied" : decision.reason)),
    ])
  );
  if (!policy || !policy.allowed) return stages;

  if (decision.risk) {
    const risk = decision.risk;
    const riskOk = risk.intentJudgment.verdict === "consistent" && risk.baselineFlags.length === 0;
    stages.push(el("div", { class: "chainArrow", text: "↓" }));
    stages.push(pipelineStage("Risk (intent + behavioral)", riskOk ? "allow" : "escalate", [document.createTextNode(`Intent: ${risk.intentJudgment.verdict}`)]));
  }

  stages.push(el("div", { class: "chainArrow", text: "↓" }));
  stages.push(pipelineStage("Decision", decision.verdict, [document.createTextNode(decision.reason)]));
  if (decision.verdict !== "allow") return stages;

  const execution = record.response.execution;
  stages.push(el("div", { class: "chainArrow", text: "↓" }));
  stages.push(
    pipelineStage("Execution", execution && execution.success ? "allow" : "deny", [
      document.createTextNode(execution ? (execution.success ? `Settled on ${execution.rail} — ${execution.reference}` : `Failed: ${execution.error}`) : "(no execution result)"),
    ])
  );
  if (!execution || !execution.success) return stages;

  stages.push(el("div", { class: "chainArrow", text: "↓" }));
  stages.push(pipelineStage("Ledger", "allow", [document.createTextNode("Recorded — hash-chained and signed")]));
  return stages;
}

function renderAttackTrace(records, txInput) {
  const container = document.getElementById("attackTrace");
  if (!container) return;
  container.innerHTML = "";
  const record = pickRepresentativeAttempt(records);
  container.appendChild(el("div", { class: "stageLabel", text: "Representative attempt — traced stage by stage", style: "margin-bottom:6px" }));
  const flow = el("div", { class: "chainFlow" });
  for (const node of buildAttackTraceStages(record, txInput)) flow.appendChild(node);
  container.appendChild(flow);
  // Same reusable stagger as the pipeline trace — the trace itself already stops
  // exactly where the real attempt stopped (buildAttackTraceStages, unchanged); this
  // only paces the reveal of that already-real, already-final sequence.
  staggerReveal(flow.childNodes);
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
  const budgetBarEl = document.getElementById("attackBudgetBar");
  budgetBarEl.style.display = "block";
  const counters = { attempts: 0, allowed: 0, blocked: 0, spendMinorUnits: 0 };
  attackUpdateStats(counters);

  const rows = [];
  const statusSpans = [];
  // One slot per attempt, filled in by fireOne() below with exactly what that
  // attempt's real response contained (or the real error, if the request itself
  // failed) — this is the only data source the pipeline trace (rendered after the
  // burst completes) is ever allowed to read from. Never fabricated, never a
  // client-side guess at what "should" have happened.
  const attemptRecords = new Array(ATTACK_ATTEMPT_COUNT).fill(null);
  for (let i = 0; i < ATTACK_ATTEMPT_COUNT; i++) {
    const statusSpan = el("span", { class: "attemptStatus", text: "···" });
    const row = el("div", { class: "attemptRow pending", title: `Attempt #${i + 1} — pending` }, [
      el("span", { class: "attemptIndex", text: `${i + 1}` }),
      statusSpan,
    ]);
    attemptsEl.appendChild(row);
    rows.push(row);
    statusSpans.push(statusSpan);
  }

  // Block 4A: only the per-row visual flip is paced below (via scheduleReveal) — the
  // counters/stat tiles keep updating immediately, in real time, every time. This
  // index only controls how spaced-out each row's color/text change appears to a
  // viewer; it has no effect on when the real request was issued or resolved.
  let revealIndex = 0;
  const fireOne = async (i) => {
    counters.attempts++;
    attackUpdateStats(counters);
    let allowed = false;
    let settled = false;
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
      attemptRecords[i] = { ok: true, response: res };
      allowed = Boolean(res.decision && res.decision.verdict === "allow");
      // Only a genuine settlement (execution.success) counts toward "spend" — a
      // decision-layer "allow" whose rail call then failed spent nothing, exactly as
      // computeMissionSpent (the server's own authoritative figure) already treats it.
      settled = allowed && Boolean(res.execution && res.execution.success);
      statusText = allowed ? (settled ? "ALLOW" : "ALLOW (unsettled)") : "DENY";
      if (allowed) {
        counters.allowed++;
        if (settled) counters.spendMinorUnits += ATTACK_AMOUNT_MINOR_UNITS;
      } else {
        counters.blocked++;
      }
    } catch (err) {
      attemptRecords[i] = { ok: false, error: err.message };
      statusText = "ERROR";
      counters.blocked++;
    }
    // Counters are the source of truth and update here, immediately — never paced.
    attackUpdateStats(counters);
    // Presentation only: the real result above is already final; this only paces
    // HOW FAST this specific row's own color/text change becomes visible, ~100ms
    // apart, so 20 near-simultaneous resolutions don't all flip within one video
    // frame. Falls back to immediate (scheduleReveal's own feature-detect) wherever
    // setTimeout isn't available, e.g. the node:vm dashboard-test sandbox.
    const myReveal = revealIndex++;
    const symbol = allowed ? (settled ? "✓" : "✓") : statusText === "ERROR" ? "!" : "✗";
    scheduleReveal(() => {
      rows[i].className = `attemptRow ${allowed ? "allow" : "deny"}${allowed && !settled ? " unsettled" : ""}`;
      rows[i].title = `Attempt #${i + 1} — ${statusText}`;
      statusSpans[i].textContent = symbol;
      // One real environment "blip" per real resolved attempt — never a count
      // independent of the 20 real requests fireOne() actually fired.
      envBlip();
    }, myReveal * 100);
  };

  await Promise.all(Array.from({ length: ATTACK_ATTEMPT_COUNT }, (_, i) => fireOne(i)));

  renderAttackTrace(attemptRecords, { amountMinorUnits: ATTACK_AMOUNT_MINOR_UNITS, currency: "USD", category, counterparty });

  // The counters above are a live, client-side tally of what each real response said —
  // this final check independently re-fetches the mission's own authoritative,
  // server-computed state (spentMinorUnits is derived entirely from the ledger, per
  // src/mission/ledger.ts's computeMissionSpent) so the displayed numbers are PROVEN
  // to match real server-side state, not merely self-consistent with the tally above.
  try {
    const mission = await api(`/missions/${encodeURIComponent(attackMissionId)}`, { auth: state.apiKey });
    const overspend = Math.max(0, mission.spentMinorUnits - mission.budgetMinorUnits);
    const detail =
      `Server-confirmed: spent ${fmtMoney(mission.spentMinorUnits, mission.currency)} of ${fmtMoney(mission.budgetMinorUnits, mission.currency)} budget ` +
      `— remaining ${fmtMoney(mission.remainingMinorUnits, mission.currency)} — overspend ${fmtMoney(overspend, mission.currency)}.`;
    // Moment-of-truth treatment (Day 1, Block 2) — the SAME .integrityBig box the
    // ledger panel already uses, not a new component. overspend is independently
    // recomputed above from the server's own authoritative figures, never assumed
    // to be zero — if the atomic reservation invariant ever genuinely failed, this
    // would honestly render "OVERSPEND DETECTED" in red, not silently stay green.
    verifiedEl.innerHTML = "";
    const cls = overspend === 0 ? "valid" : "invalid";
    const headline = overspend === 0 ? "✓ ZERO OVERSPEND — BUDGET HELD" : "✗ OVERSPEND DETECTED";
    let boxClass = `integrityBig ${cls}`;
    if (overspend === 0 && !attackZeroOverspendPulsedOnce) {
      boxClass += " pulse";
      attackZeroOverspendPulsedOnce = true;
    }
    verifiedEl.appendChild(el("div", { class: boxClass }, [document.createTextNode(headline)]));
    verifiedEl.appendChild(el("div", { class: "hint", text: detail, style: "margin-top:6px" }));
    pulseAtmosphere(overspend === 0 ? "allow" : "deny");
    envSignalTo(1, overspend === 0 ? "allow" : "deny");
    refreshLedger(); // 20 real ledger writes just happened — keep the shell status chip and Evidence workspace honest
  } catch (err) {
    verifiedEl.innerHTML = "";
    verifiedEl.appendChild(el("div", { class: "hint", text: `Could not confirm server-side mission state: ${err.message}` }));
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
    // Plain text, not an emoji — cross-platform recording reliability (emoji glyph
    // support/rendering varies by OS/font stack) and consistency with the ✓/✗
    // ASCII-adjacent vocabulary used everywhere else in this dashboard.
    if (node.revoked) top.appendChild(el("span", { class: "lockBadge", text: "REVOKED" }));
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

/**
 * `big`, when true, renders the verdict as the same .integrityBig moment-of-truth box
 * already used for ledger integrity (Day 1, Block 2) instead of the small in-card
 * badge — used only for the AFTER-revocation result, since that's the actual proof
 * moment; BEFORE stays the normal small treatment so the contrast itself reads as
 * "something changed". No new visual language: same classes, same allow=green/
 * deny=red semantics as everywhere else on this dashboard.
 */
function renderRevocationResult(label, result, railCalls, big) {
  if (big) {
    const wrapper = el("div", { style: "margin-top:8px" });
    wrapper.appendChild(el("div", { class: "stageLabel", text: label, style: "margin-bottom:4px" }));
    let verdictText = "(no result)";
    let cls = "invalid";
    let explain = "";
    if (result && result.__error) {
      verdictText = "✗ REQUEST FAILED";
      explain = result.__error;
    } else if (result && result.decision) {
      const allowed = result.decision.verdict === "allow";
      verdictText = allowed ? "✓ ALLOWED" : `✗ ${result.decision.verdict.toUpperCase()}`;
      cls = allowed ? "valid" : "invalid";
      explain = result.decision.reason;
    }
    wrapper.appendChild(el("div", { class: `integrityBig ${cls}`, text: verdictText }));
    if (explain) wrapper.appendChild(el("div", { class: "hint", text: explain, style: "margin-top:6px" }));
    if (railCalls !== undefined) {
      wrapper.appendChild(el("div", { class: "hint", text: `Rail calls after revocation: ${railCalls}` }));
    }
    return wrapper;
  }

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
    wrapper.appendChild(el("div", { class: "hint", text: `Rail calls after revocation: ${railCalls}` }));
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
      { role: "Parent", agentId: parentId, caveats: parentCaveats, revoked: false },
      { role: "Child (attenuated)", agentId: childId, caveats: childCaveats, revoked: false },
    ]);

    const txBody = {
      transaction: { amountMinorUnits: 38_000, currency: "USD", category: "flights", rail: "mock_x402", purpose: "Attack-theatre revocation probe" },
      counterparty: "acme-airlines",
    };

    const before = await api("/transactions", { method: "POST", auth: childRes.token, headers: { "idempotency-key": crypto.randomUUID() }, body: txBody }).catch((err) => ({ __error: err.message }));
    resultsEl.appendChild(renderRevocationResult("Before revocation", before));

    await api(`/agents/${childId}/revoke`, { method: "POST", auth: state.apiKey, body: { reason: "Attack-theatre demo revocation" } });
    renderDelegationChain(chainEl, [
      { role: "Parent", agentId: parentId, caveats: parentCaveats, revoked: false },
      { role: "Child (attenuated)", agentId: childId, caveats: childCaveats, revoked: true },
    ]);

    const after = await api("/transactions", { method: "POST", auth: childRes.token, headers: { "idempotency-key": crypto.randomUUID() }, body: txBody }).catch((err) => ({ __error: err.message }));
    // "Rail calls" is read directly off the real response's own shape — execution is
    // only ever present when verdict === "allow" (see executeTransaction's own,
    // unmodified contract) — never asserted or assumed independent of what the server
    // actually returned.
    const railCalls = after && after.execution ? 1 : 0;
    resultsEl.appendChild(renderRevocationResult("After revocation", after, railCalls, true));
    // The environment's deny reaction fires only once the server has actually
    // confirmed the post-revocation attempt was denied — never on the optimistic
    // assumption that revoke() alone means the next attempt will fail.
    if (after && after.decision && after.decision.verdict !== "allow") envSignalTo(1, "deny");
    refreshLedger(); // the revocation itself and both real attempts wrote real ledger entries
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
    let cls = `integrityBig ${res.chainValid ? "valid" : "invalid"}`;
    if (res.chainValid && !integrityPulsedOnce) {
      cls += " pulse";
      integrityPulsedOnce = true;
    }
    statusEl.className = cls;
    statusEl.textContent = res.chainValid ? "✓ HASH CHAIN VERIFIED" : "✗ INTEGRITY VIOLATION DETECTED";
    pulseAtmosphere(res.chainValid ? "allow" : "deny");
    envSignalTo(1, res.chainValid ? "allow" : "deny");
    updateShellStatus(res.chainValid, res.entries.length);
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
