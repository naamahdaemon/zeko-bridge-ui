import { connectWallet, getConnectedAccount, sendTransaction } from "./wallet.js";
import {
  initBridge,
  submitDepositTx,
  submitWithdrawalTx,
  fetchDepositStates,
  fetchWithdrawalStates,
  getDepositCapabilities,
  getWithdrawalCapabilities,
  buildFinalizeDepositTx,
  buildCancelDepositTx,
  buildFinalizeWithdrawalTx
} from "./bridge.js";

const STORAGE_KEY = "zeko-bridge-ui:v2";
const POLL_INTERVAL_MS = 15000;
const SLOT_DURATION_MS = 180000;
const L1_NETWORK_ID = "mina:devnet";
const L2_NETWORK_ID = "zeko:testnet";

const els = {
  connect: document.getElementById("connect"),
  account: document.getElementById("account"),
  connectionStatus: document.getElementById("connectionStatus"),
  amount: document.getElementById("amount"),
  fee: document.getElementById("fee"),
  deposit: document.getElementById("deposit"),
  withdraw: document.getElementById("withdraw"),

  refreshState: document.getElementById("refreshState"),
  startPolling: document.getElementById("startPolling"),
  stopPolling: document.getElementById("stopPolling"),
  pollingStatus: document.getElementById("pollingStatus"),
  lastRefresh: document.getElementById("lastRefresh"),

  nextClaimableDeposit: document.getElementById("nextClaimableDeposit"),
  nextCancellableDeposit: document.getElementById("nextCancellableDeposit"),
  depositGlobalReason: document.getElementById("depositGlobalReason"),
  claimNextDeposit: document.getElementById("claimNextDeposit"),
  cancelNextDeposit: document.getElementById("cancelNextDeposit"),

  nextFinalizableWithdrawal: document.getElementById("nextFinalizableWithdrawal"),
  withdrawalGlobalReason: document.getElementById("withdrawalGlobalReason"),
  finalizeNextWithdrawal: document.getElementById("finalizeNextWithdrawal"),

  depositSummary: document.getElementById("depositSummary"),
  depositQueue: document.getElementById("depositQueue"),

  withdrawalSummary: document.getElementById("withdrawalSummary"),
  withdrawalQueue: document.getElementById("withdrawalQueue"),

  clearHistory: document.getElementById("clearHistory"),
  localHistory: document.getElementById("localHistory"),

  log: document.getElementById("log")
};

let account = null;
let bridge = null;
let pollTimer = null;
let pollingInFlight = false;

function log(...args) {
  const line = args
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2)))
    .join(" ");
  els.log.textContent = `${new Date().toISOString()} ${line}\n${els.log.textContent}`;
}

function requireConnected() {
  if (!account) throw new Error("Wallet is not connected.");
}

function requireBridge() {
  if (!bridge) throw new Error("Bridge is not initialized.");
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveState(next) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function getStoredHistory() {
  const s = loadState();
  return Array.isArray(s.history) ? s.history : [];
}

function setStoredHistory(history) {
  const s = loadState();
  saveState({ ...s, history });
}

function appendHistory(entry) {
  const history = getStoredHistory();
  history.unshift(entry);
  setStoredHistory(history.slice(0, 100));
  renderLocalHistory();
}

function clearHistory() {
  const s = loadState();
  saveState({ ...s, history: [] });
  renderLocalHistory();
}

function formatMinaFromNanoLike(value) {
  if (value == null) return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return (num / 1e9).toString();
}

function safeText(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function shortPk(pk) {
  if (!pk) return "-";
  const s = typeof pk === "string" ? pk : pk.toBase58?.() ?? String(pk);
  if (s.length <= 18) return s;
  return `${s.slice(0, 8)}...${s.slice(-8)}`;
}

function truncateMiddle(value, start = 10, end = 10) {
  const text = safeText(value);
  if (text === "-" || text.length <= start + end + 3) return text;
  return `${text.slice(0, start)}...${text.slice(-end)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHashValue(hash) {
  const fullHash = safeText(hash);
  if (fullHash === "-") {
    return `<span class="hash-value">-</span>`;
  }

  const shortHash = truncateMiddle(fullHash, 10, 8);
  const escapedFullHash = escapeHtml(fullHash);
  const escapedShortHash = escapeHtml(shortHash);

  return `
    <span class="hash-row" title="${escapedFullHash}">
      <code class="hash-value">${escapedShortHash}</code>
      <button
        type="button"
        class="copy-chip"
        data-copy="${escapedFullHash}"
        aria-label="Copy full hash"
        title="Copy full hash"
      >
        Copy
      </button>
    </span>
  `;
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function normalizeTimestampMs(value) {
  if (value === null || value === undefined || value === "") return null;

  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || raw === "0" || raw === 0) return null;

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  if (numeric < 1e10) return numeric * 1000;
  if (numeric < 1e12) return numeric * 10;
  return numeric;
}

function formatChainTimestamp(value) {
  const normalized = normalizeTimestampMs(value);
  if (normalized == null) return "-";
  return formatDateTime(normalized);
}

function getBridgeDelayMs() {
  const slots = Number(bridge?.withdrawalDelay?.toString?.() ?? bridge?.withdrawalDelay ?? 0);
  if (!Number.isFinite(slots) || slots <= 0) return null;
  return slots * SLOT_DURATION_MS;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "less than a minute";

  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatEta(targetMs) {
  if (!Number.isFinite(targetMs)) return "-";

  const delta = targetMs - Date.now();
  if (delta <= 0) return "now";

  return `${formatDuration(delta)} remaining`;
}

function estimateWithdrawalLabel(withdrawal) {
  if (withdrawal.finalised) return "Finalized";
  if (withdrawal.committed) return "Ready to finalize";

  const delayMs = getBridgeDelayMs();
  const timestampMs = normalizeTimestampMs(withdrawal.timestamp);

  if (delayMs != null && timestampMs != null) {
    const targetMs = timestampMs + delayMs;
    return `Likely finalizable around ${formatDateTime(targetMs)} (${formatEta(targetMs)})`;
  }

  return "Waiting for bridge commit";
}

function estimateDepositLabel(deposit) {
  if (deposit.finalised) return "Claimed";
  if (deposit.cancelled) return "Canceled";
  if (deposit.confirmed) return "Ready to claim";

  const delayMs = getBridgeDelayMs();
  const timestampMs = normalizeTimestampMs(deposit.timestamp);

  if (!deposit.accepted && delayMs != null && timestampMs != null) {
    const targetMs = timestampMs + delayMs;
    return `Likely accepted around ${formatDateTime(targetMs)} (${formatEta(targetMs)})`;
  }

  if (deposit.accepted && !deposit.confirmed) {
    return "Accepted, waiting for synchronization";
  }

  if (!deposit.synced) {
    return "Waiting to sync into the bridge queue";
  }

  return "Waiting for bridge confirmation";
}

function renderTopStatus() {
  els.account.textContent = account || "Not connected";
  els.connectionStatus.textContent = account ? "Wallet connected" : "Wallet disconnected";
  els.connectionStatus.classList.toggle("connected", Boolean(account));
  els.pollingStatus.textContent = pollTimer ? "Running" : "Stopped";
  els.lastRefresh.textContent = formatDateTime(uiState.lastRefreshAt);
}

function pickNextClaimableDeposit(state) {
  if (!state?.deposits?.length) return null;
  return [...state.deposits]
    .filter((d) => d.confirmed && !d.finalised && !d.cancelled)
    .sort((a, b) => a.index - b.index)[0] ?? null;
}

function pickNextCancellableDeposit(state) {
  if (!state?.deposits?.length) return null;
  return [...state.deposits]
    .filter((d) => !d.accepted && !d.cancelled && !d.finalised)
    .sort((a, b) => a.index - b.index)[0] ?? null;
}

function pickNextFinalizableWithdrawal(state) {
  if (!state?.withdrawals?.length) return null;
  return [...state.withdrawals]
    .filter((w) => w.committed && !w.finalised)
    .sort((a, b) => a.index - b.index)[0] ?? null;
}

function isLikelyTransientFinalizeError(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("constraint unsatisfied") ||
    m.includes("failed to prove deposit finalization") ||
    m.includes("monitor.ml.error") ||
    m.includes("did not find any deposit to finalize") ||
    m.includes("did not find deposit to cancel") ||
    m.includes("did not find withdrawal to finalize")
  );
}

const uiState = {
  depositState: null,
  depositCapabilities: null,
  withdrawalState: null,
  withdrawalCapabilities: null,
  lastRefreshAt: null
};

function renderSummaryGrid(container, items) {
  container.innerHTML = items
    .map(
      (item) => `
        <div class="summary-item">
          <div class="label">${item.label}</div>
          <div class="value">${safeText(item.value)}</div>
        </div>
      `
    )
    .join("");
}

function renderDepositQueue() {
  const state = uiState.depositState;
  const caps = uiState.depositCapabilities;
  const nextClaimable = pickNextClaimableDeposit(state);
  const nextCancellable = pickNextCancellableDeposit(state);

  els.nextClaimableDeposit.textContent = nextClaimable
    ? `index ${nextClaimable.index} • ${formatMinaFromNanoLike(nextClaimable.amount.toString())} MINA`
    : "-";

  els.nextCancellableDeposit.textContent = nextCancellable
    ? `index ${nextCancellable.index} • ${formatMinaFromNanoLike(nextCancellable.amount.toString())} MINA`
    : "-";

  els.depositGlobalReason.textContent =
    caps?.finalizeReason ||
    caps?.cancelReason ||
    "-";

  els.claimNextDeposit.disabled = !caps?.canFinalize;
  els.cancelNextDeposit.disabled = !caps?.canCancel;

  renderSummaryGrid(els.depositSummary, [
    { label: "Total deposits", value: state?.deposits?.length ?? 0 },
    { label: "Synced index", value: state?.syncedIndex ?? "-" },
    { label: "Accepted index", value: state?.acceptedIndex ?? "-" },
    { label: "Confirmed index", value: state?.confirmedIndex ?? "-" },
    { label: "Finalised index", value: state?.finalisedIndex ?? "-" },
    { label: "Cancelled index", value: state?.cancelledIndex ?? "-" }
  ]);

  if (!state?.deposits?.length) {
    els.depositQueue.innerHTML = `<div class="queue-item"><div class="queue-title">No deposits found for this wallet.</div></div>`;
    return;
  }

  const nextClaimableIndex = nextClaimable?.index ?? null;
  const nextCancellableIndex = nextCancellable?.index ?? null;

  const html = [...state.deposits]
    .sort((a, b) => a.index - b.index)
    .map((d) => {
      const recipient = d.recipient?.toBase58?.() ?? String(d.recipient);
      const amount = d.amount?.toString?.() ?? String(d.amount);
      const timeout = d.timeout?.toString?.() ?? String(d.timeout);
      const holder = d.holderAccountL1?.toBase58?.() ?? String(d.holderAccountL1);

      const isNextAction = d.index === nextClaimableIndex || d.index === nextCancellableIndex;
      const isDone = d.finalised || d.cancelled;

      const classes = [
        "queue-item",
        isNextAction ? "next-action" : "",
        !isDone && !d.accepted && d.synced ? "warning" : "",
        isDone ? "done" : ""
      ]
        .filter(Boolean)
        .join(" ");

      return `
        <div class="${classes}">
          <div class="queue-title">
            Deposit #${d.index}
            ${d.index === nextClaimableIndex ? "• next claimable" : ""}
            ${d.index === nextCancellableIndex ? "• next cancellable" : ""}
          </div>

          <div class="queue-grid">
            <div><strong>Amount:</strong> ${formatMinaFromNanoLike(amount)} MINA</div>
            <div><strong>Recipient:</strong> ${shortPk(recipient)}</div>
            <div><strong>Holder:</strong> ${shortPk(holder)}</div>
            <div><strong>Timeout:</strong> ${timeout}</div>
              <div><strong>Hash:</strong> ${renderHashValue(d.hash)}</div>
            <div><strong>Timestamp:</strong> ${formatChainTimestamp(d.timestamp)}</div>
            <div><strong>Estimate:</strong> ${estimateDepositLabel(d)}</div>
          </div>

          <div class="queue-badges">
            <span class="badge ${d.synced ? "ok" : "dim"}">synced: ${d.synced}</span>
            <span class="badge ${d.accepted ? "ok" : "warn"}">accepted: ${d.accepted}</span>
            <span class="badge ${d.confirmed ? "ok" : "dim"}">confirmed: ${d.confirmed}</span>
            <span class="badge ${d.finalised ? "ok" : "dim"}">finalised: ${d.finalised}</span>
            <span class="badge ${d.cancelled ? "warn" : "dim"}">cancelled: ${d.cancelled}</span>
          </div>
        </div>
      `;
    })
    .join("");

  els.depositQueue.innerHTML = html;
}

function renderWithdrawalQueue() {
  const state = uiState.withdrawalState;
  const caps = uiState.withdrawalCapabilities;
  const nextFinalizable = pickNextFinalizableWithdrawal(state);

  els.nextFinalizableWithdrawal.textContent = nextFinalizable
    ? `index ${nextFinalizable.index} • ${formatMinaFromNanoLike(nextFinalizable.amount.toString())} MINA`
    : "-";

  els.withdrawalGlobalReason.textContent = caps?.finalizeReason || "-";
  els.finalizeNextWithdrawal.disabled = !caps?.canFinalize;

  renderSummaryGrid(els.withdrawalSummary, [
    { label: "Total withdrawals", value: state?.withdrawals?.length ?? 0 },
    { label: "Committed index", value: state?.committedIndex ?? "-" },
    { label: "Finalised index", value: state?.finalisedIndex ?? "-" }
  ]);

  if (!state?.withdrawals?.length) {
    els.withdrawalQueue.innerHTML = `<div class="queue-item"><div class="queue-title">No withdrawals found for this wallet.</div></div>`;
    return;
  }

  const nextFinalizableIndex = nextFinalizable?.index ?? null;

  const html = [...state.withdrawals]
    .sort((a, b) => a.index - b.index)
    .map((w) => {
      const recipient = w.recipient?.toBase58?.() ?? String(w.recipient);
      const amount = w.amount?.toString?.() ?? String(w.amount);

      const isNextAction = w.index === nextFinalizableIndex;
      const isDone = w.finalised;

      const classes = [
        "queue-item",
        isNextAction ? "next-action" : "",
        isDone ? "done" : ""
      ]
        .filter(Boolean)
        .join(" ");

      return `
        <div class="${classes}">
          <div class="queue-title">
            Withdrawal #${w.index}
            ${w.index === nextFinalizableIndex ? "• next finalizable" : ""}
          </div>

          <div class="queue-grid">
            <div><strong>Amount:</strong> ${formatMinaFromNanoLike(amount)} MINA</div>
            <div><strong>Recipient:</strong> ${shortPk(recipient)}</div>
              <div><strong>Hash:</strong> ${renderHashValue(w.hash)}</div>
            <div><strong>Timestamp:</strong> ${formatChainTimestamp(w.timestamp)}</div>
            <div><strong>Estimate:</strong> ${estimateWithdrawalLabel(w)}</div>
          </div>

          <div class="queue-badges">
            <span class="badge ${w.committed ? "ok" : "dim"}">committed: ${w.committed}</span>
            <span class="badge ${w.finalised ? "ok" : "dim"}">finalised: ${w.finalised}</span>
          </div>
        </div>
      `;
    })
    .join("");

  els.withdrawalQueue.innerHTML = html;
}

function renderLocalHistory() {
  const history = getStoredHistory();

  if (!history.length) {
    els.localHistory.innerHTML = `<div class="queue-item"><div class="queue-title">No local history yet.</div><div class="hint">Submitted transactions from this browser will appear here.</div></div>`;
    return;
  }

  els.localHistory.innerHTML = history
    .map((h) => {
      return `
        <div class="queue-item">
          <div class="queue-title">${safeText(h.type)} • ${safeText(h.status)}</div>
            <div class="queue-grid">
              <div><strong>Time:</strong> ${safeText(h.time)}</div>
              <div><strong>Hash:</strong> ${renderHashValue(h.hash)}</div>
              <div><strong>Amount:</strong> ${safeText(h.amount)}</div>
              <div><strong>Fee:</strong> ${safeText(h.fee)}</div>
              <div><strong>Memo:</strong> ${safeText(h.memo)}</div>
            <div><strong>Error:</strong> ${safeText(h.error)}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderAll() {
  renderTopStatus();
  renderDepositQueue();
  renderWithdrawalQueue();
  renderLocalHistory();
}

async function initializeBridge() {
  log("Initializing bridge...");
  bridge = await initBridge();
  if (!bridge) throw new Error("Bridge.init returned null/undefined");
  log("Bridge initialized");
  log("outerHolders:", bridge.outerHolders ?? []);
}

async function refreshQueues() {
  requireConnected();
  requireBridge();

  const [depositState, depositCapabilities, withdrawalState, withdrawalCapabilities] =
    await Promise.all([
      fetchDepositStates(bridge, account),
      getDepositCapabilities(bridge, account),
      fetchWithdrawalStates(bridge, account),
      getWithdrawalCapabilities(bridge, account)
    ]);

  uiState.depositState = depositState;
  uiState.depositCapabilities = depositCapabilities;
  uiState.withdrawalState = withdrawalState;
  uiState.withdrawalCapabilities = withdrawalCapabilities;
  uiState.lastRefreshAt = new Date().toISOString();

  renderAll();
}

async function pollOnce() {
  if (pollingInFlight) return;
  pollingInFlight = true;

  try {
    await refreshQueues();
  } catch (error) {
    log("Polling error:", error?.message || error);
    console.error(error);
  } finally {
    pollingInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  log(`Starting polling every ${POLL_INTERVAL_MS / 1000}s`);
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  renderTopStatus();
  void pollOnce();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  log("Stopped polling");
  renderTopStatus();
}

async function safelyRefreshBeforeAction() {
  await refreshQueues();
}

els.connect.addEventListener("click", async () => {
  try {
    account = await connectWallet();
    log("Connected:", account);

    await initializeBridge();
    await refreshQueues();
    startPolling();
  } catch (error) {
    bridge = null;
    log("Connect/init error:", error?.message || error);
    console.error(error);
  }
});

els.refreshState.addEventListener("click", async () => {
  try {
    await refreshQueues();
    log("State refreshed");
  } catch (error) {
    log("Refresh error:", error?.message || error);
    console.error(error);
  }
});

els.startPolling.addEventListener("click", () => {
  try {
    requireBridge();
    startPolling();
  } catch (error) {
    log("Start polling error:", error?.message || error);
  }
});

els.stopPolling.addEventListener("click", () => {
  stopPolling();
});

els.deposit.addEventListener("click", async () => {
  try {
    requireConnected();
    requireBridge();

    const amount = els.amount.value;
    const fee = els.fee.value;

    log("Building deposit transaction...");
    const tx = await submitDepositTx(bridge, account, amount, fee);

    log("Sending deposit transaction...");
    const result = await sendTransaction(tx, fee, "zeko-deposit", {
      requiredNetwork: L1_NETWORK_ID
    });

    const hash =
      result?.hash ||
      result?.transactionHash ||
      result?.txHash ||
      result?.id ||
      null;

    appendHistory({
      type: "deposit-submit",
      status: "submitted",
      hash,
      amount,
      fee,
      memo: "zeko-deposit",
      time: new Date().toISOString(),
      error: null
    });

    log("Deposit submitted:", result);
    await refreshQueues();
    startPolling();
  } catch (error) {
    appendHistory({
      type: "deposit-submit",
      status: "error",
      hash: null,
      amount: els.amount.value,
      fee: els.fee.value,
      memo: "zeko-deposit",
      time: new Date().toISOString(),
      error: error?.message || String(error)
    });
    log("Deposit error:", error?.message || error);
    console.error(error);
  }
});

els.withdraw.addEventListener("click", async () => {
  try {
    requireConnected();
    requireBridge();

    const amount = els.amount.value;
    const fee = els.fee.value;

    log("Building withdrawal transaction...");
    const tx = await submitWithdrawalTx(bridge, account, amount, fee);

    log("Sending withdrawal transaction...");
    const result = await sendTransaction(tx, fee, "zeko-withdraw", {
      requiredNetwork: L2_NETWORK_ID
    });

    const hash =
      result?.hash ||
      result?.transactionHash ||
      result?.txHash ||
      result?.id ||
      null;

    appendHistory({
      type: "withdraw-submit",
      status: "submitted",
      hash,
      amount,
      fee,
      memo: "zeko-withdraw",
      time: new Date().toISOString(),
      error: null
    });

    log("Withdrawal submitted:", result);
    await refreshQueues();
    startPolling();
  } catch (error) {
    appendHistory({
      type: "withdraw-submit",
      status: "error",
      hash: null,
      amount: els.amount.value,
      fee: els.fee.value,
      memo: "zeko-withdraw",
      time: new Date().toISOString(),
      error: error?.message || String(error)
    });
    log("Withdrawal error:", error?.message || error);
    console.error(error);
  }
});

els.claimNextDeposit.addEventListener("click", async () => {
  try {
    requireConnected();
    requireBridge();

    await safelyRefreshBeforeAction();

    const caps = uiState.depositCapabilities;
    const nextClaimable = pickNextClaimableDeposit(uiState.depositState);

    if (!caps?.canFinalize || !nextClaimable) {
      log("No claimable deposit available after refresh.");
      return;
    }

    const fee = els.fee.value;

    log("Claiming next eligible deposit...", {
      sdkTargetIndex: nextClaimable.index,
      amount: nextClaimable.amount.toString(),
      hash: nextClaimable.hash
    });

    const tx = await buildFinalizeDepositTx(bridge, account, fee);
    const result = await sendTransaction(tx, fee, "zeko-finalize-deposit", {
      requiredNetwork: L2_NETWORK_ID
    });

    const hash =
      result?.hash ||
      result?.transactionHash ||
      result?.txHash ||
      result?.id ||
      null;

    appendHistory({
      type: "deposit-claim-next",
      status: "submitted",
      hash,
      amount: formatMinaFromNanoLike(nextClaimable.amount.toString()),
      fee,
      memo: "zeko-finalize-deposit",
      time: new Date().toISOString(),
      error: null
    });

    log("Claim next eligible deposit submitted:", result);
    await refreshQueues();
  } catch (error) {
    const message = error?.message || String(error);

    appendHistory({
      type: "deposit-claim-next",
      status: "error",
      hash: null,
      amount: null,
      fee: els.fee.value,
      memo: "zeko-finalize-deposit",
      time: new Date().toISOString(),
      error: message
    });

    if (isLikelyTransientFinalizeError(message)) {
      log("Transient claim error; refreshing queue state...", message);
      try {
        await refreshQueues();
      } catch (refreshError) {
        log("Refresh after claim error failed:", refreshError?.message || refreshError);
      }
      return;
    }

    log("Claim next deposit error:", message);
    console.error(error);
  }
});

els.cancelNextDeposit.addEventListener("click", async () => {
  try {
    requireConnected();
    requireBridge();

    await safelyRefreshBeforeAction();

    const caps = uiState.depositCapabilities;
    const nextCancellable = pickNextCancellableDeposit(uiState.depositState);

    if (!caps?.canCancel || !nextCancellable) {
      log("No cancellable deposit available after refresh.");
      return;
    }

    const fee = els.fee.value;

    log("Cancelling next eligible deposit...", {
      sdkTargetIndex: nextCancellable.index,
      amount: nextCancellable.amount.toString(),
      hash: nextCancellable.hash
    });

    const tx = await buildCancelDepositTx(bridge, account, fee);
    const result = await sendTransaction(tx, fee, "zeko-cancel-deposit", {
      requiredNetwork: L1_NETWORK_ID
    });

    const hash =
      result?.hash ||
      result?.transactionHash ||
      result?.txHash ||
      result?.id ||
      null;

    appendHistory({
      type: "deposit-cancel-next",
      status: "submitted",
      hash,
      amount: formatMinaFromNanoLike(nextCancellable.amount.toString()),
      fee,
      memo: "zeko-cancel-deposit",
      time: new Date().toISOString(),
      error: null
    });

    log("Cancel next eligible deposit submitted:", result);
    await refreshQueues();
  } catch (error) {
    const message = error?.message || String(error);

    appendHistory({
      type: "deposit-cancel-next",
      status: "error",
      hash: null,
      amount: null,
      fee: els.fee.value,
      memo: "zeko-cancel-deposit",
      time: new Date().toISOString(),
      error: message
    });

    if (isLikelyTransientFinalizeError(message)) {
      log("Transient cancel error; refreshing queue state...", message);
      try {
        await refreshQueues();
      } catch (refreshError) {
        log("Refresh after cancel error failed:", refreshError?.message || refreshError);
      }
      return;
    }

    log("Cancel next deposit error:", message);
    console.error(error);
  }
});

els.finalizeNextWithdrawal.addEventListener("click", async () => {
  try {
    requireConnected();
    requireBridge();

    await safelyRefreshBeforeAction();

    const caps = uiState.withdrawalCapabilities;
    const nextFinalizable = pickNextFinalizableWithdrawal(uiState.withdrawalState);

    if (!caps?.canFinalize || !nextFinalizable) {
      log("No finalizable withdrawal available after refresh.");
      return;
    }

    const fee = els.fee.value;

    log("Finalizing next eligible withdrawal...", {
      sdkTargetIndex: nextFinalizable.index,
      amount: nextFinalizable.amount.toString(),
      hash: nextFinalizable.hash
    });

    const tx = await buildFinalizeWithdrawalTx(bridge, account, fee);
    const result = await sendTransaction(tx, fee, "zeko-finalize-withdrawal", {
      requiredNetwork: L1_NETWORK_ID
    });

    const hash =
      result?.hash ||
      result?.transactionHash ||
      result?.txHash ||
      result?.id ||
      null;

    appendHistory({
      type: "withdraw-finalize-next",
      status: "submitted",
      hash,
      amount: formatMinaFromNanoLike(nextFinalizable.amount.toString()),
      fee,
      memo: "zeko-finalize-withdrawal",
      time: new Date().toISOString(),
      error: null
    });

    log("Finalize next eligible withdrawal submitted:", result);
    await refreshQueues();
  } catch (error) {
    const message = error?.message || String(error);

    appendHistory({
      type: "withdraw-finalize-next",
      status: "error",
      hash: null,
      amount: null,
      fee: els.fee.value,
      memo: "zeko-finalize-withdrawal",
      time: new Date().toISOString(),
      error: message
    });

    if (isLikelyTransientFinalizeError(message)) {
      log("Transient finalize-withdrawal error; refreshing queue state...", message);
      try {
        await refreshQueues();
      } catch (refreshError) {
        log("Refresh after finalize-withdrawal error failed:", refreshError?.message || refreshError);
      }
      return;
    }

    log("Finalize next withdrawal error:", message);
    console.error(error);
  }
});

els.clearHistory.addEventListener("click", () => {
  clearHistory();
  log("Cleared local history");
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;

  const value = button.getAttribute("data-copy");
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    log("Copied hash to clipboard");
  } catch (error) {
    log("Clipboard copy error:", error?.message || error);
  }
});

(async function boot() {
  try {
    renderAll();

    const existing = await getConnectedAccount();
    if (existing) {
      account = existing;
      log("Wallet already connected:", existing);

      await initializeBridge();
      await refreshQueues();
      startPolling();
    }
  } catch (error) {
    log("Boot info:", error?.message || error);
  }
})();
