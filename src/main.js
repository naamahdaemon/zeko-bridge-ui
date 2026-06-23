import { connectWallet, createWalletTransactionSigner, getConnectedAccount, getCurrentNetwork } from "./wallet.js";
import {
  getBridgeNetworkOptions,
  getCurrentBridgeNetworkId,
  getCurrentBridgePreset,
  initBridge,
  setBridgeNetwork,
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
const POLLING_DRAIN_TIMEOUT_MS = 30000;
const SLOT_DURATION_MS = 180000;
const DESKTOP_MEDIA_QUERY = window.matchMedia("(min-width: 901px)");
const DESKTOP_BASE_WIDTH = 1180;
const MAX_VISIBLE_QUEUE_HISTORY_ITEMS = 5;
const BRIDGE_NETWORK_SELECTION_AUTO = "auto";
const BRIDGE_NETWORK_SELECTION_MANUAL = "manual";
const ACTION_STATUS_HIDE_DELAY_MS = 8000;
const ACTION_STATUS_AUTO_REDUCE_BOTTOM_THRESHOLD_PX = 140;

const els = {
  connect: document.getElementById("connect"),
  toggleDesktopMode: document.getElementById("toggleDesktopMode"),
  desktopModeIcon: document.getElementById("desktopModeIcon"),
  actionStatusIndicator: document.getElementById("actionStatusIndicator"),
  actionStatusIndicatorGlyph: document.getElementById("actionStatusIndicatorGlyph"),
  actionStatusIndicatorLabel: document.getElementById("actionStatusIndicatorLabel"),
  toggleThemeMode: document.getElementById("toggleThemeMode"),
  themeModeIcon: document.getElementById("themeModeIcon"),
  account: document.getElementById("account"),
  walletNetwork: document.getElementById("walletNetwork"),
  connectionStatus: document.getElementById("connectionStatus"),
  amount: document.getElementById("amount"),
  fee: document.getElementById("fee"),
  deposit: document.getElementById("deposit"),
  withdraw: document.getElementById("withdraw"),
  bridgeNetwork: document.getElementById("bridgeNetwork"),

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

  actionStatus: document.getElementById("actionStatus"),
  actionStatusPill: document.getElementById("actionStatusPill"),
  actionStatusTitle: document.getElementById("actionStatusTitle"),
  actionStatusDetail: document.getElementById("actionStatusDetail"),
  actionStatusProgress: document.getElementById("actionStatusProgress"),
  actionStatusElapsed: document.getElementById("actionStatusElapsed"),
  actionStatusHint: document.getElementById("actionStatusHint"),
  actionStatusClose: document.getElementById("actionStatusClose"),
  actionStatusReduced: document.getElementById("actionStatusReduced"),
  actionStatusReducedText: document.getElementById("actionStatusReducedText"),

  log: document.getElementById("log")
};

let account = null;
let bridge = null;
let pollTimer = null;
let pollingInFlight = false;
let actionInFlight = false;
let refreshGeneration = 0;
let bridgeNetworkGeneration = 0;
let fullscreenCardId = null;
let forceDesktopMode = false;
let themeMode = loadPreferences().theme === "dark" ? "dark" : "light";
let orderedCardIds = [];
let touchGestureStart = null;
let pointerGestureStart = null;
let walletNetwork = null;
let actionStatusTickTimer = null;
let actionStatusHideTimer = null;
let backgroundStatusShowTimer = null;

const actionStatusState = {
  visible: false,
  dismissed: false,
  owner: null,
  tone: "working",
  label: "Action in progress",
  title: "",
  detail: "",
  hint: "Live updates are shown here while the SDK is working.",
  startedAt: null
};

const ICONS = {
  mobile: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="2.75" width="10" height="18.5" rx="2.5"></rect>
      <path d="M10 5.75h4"></path>
      <path d="M11.25 18.25h1.5"></path>
    </svg>
  `,
  desktop: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2"></rect>
      <path d="M9 20h6"></path>
      <path d="M12 16v4"></path>
    </svg>
  `,
  light: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2.5v2.25"></path>
      <path d="M12 19.25v2.25"></path>
      <path d="M21.5 12h-2.25"></path>
      <path d="M4.75 12H2.5"></path>
      <path d="M18.72 5.28l-1.59 1.59"></path>
      <path d="M6.87 17.13l-1.59 1.59"></path>
      <path d="M18.72 18.72l-1.59-1.59"></path>
      <path d="M6.87 6.87L5.28 5.28"></path>
    </svg>
  `,
  dark: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.75 8.75 0 1 0 20.5 14.2Z"></path>
    </svg>
  `
};

function log(...args) {
  const line = args
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2)))
    .join(" ");
  els.log.textContent = `${new Date().toISOString()} ${line}\n${els.log.textContent}`;
}

function formatElapsedMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function clearActionStatusHideTimer() {
  if (!actionStatusHideTimer) return;
  clearTimeout(actionStatusHideTimer);
  actionStatusHideTimer = null;
}

function clearBackgroundStatusShowTimer() {
  if (!backgroundStatusShowTimer) return;
  clearTimeout(backgroundStatusShowTimer);
  backgroundStatusShowTimer = null;
}

function stopActionStatusTicking() {
  if (!actionStatusTickTimer) return;
  clearInterval(actionStatusTickTimer);
  actionStatusTickTimer = null;
}

function ensureActionStatusTicking() {
  if (actionStatusTickTimer || !actionStatusState.startedAt || !actionStatusState.owner) {
    return;
  }

  actionStatusTickTimer = setInterval(() => {
    renderActionStatus();
  }, 1000);
}

function getActionStatusTooltip() {
  if (!actionStatusState.owner) {
    return "No action in progress";
  }

  const parts = [actionStatusState.title, actionStatusState.detail].filter(Boolean);
  return parts.join(" - ") || "Action status";
}

function getActionStatusIndicatorText() {
  if (!actionStatusState.owner) return "";
  return actionStatusState.title || actionStatusState.label || "";
}

function renderActionStatusIndicator() {
  if (!els.actionStatusIndicator) return;

  const isBusy = Boolean(actionStatusState.owner) && actionStatusState.tone === "working";
  const tooltip = getActionStatusTooltip();
  const indicatorText = getActionStatusIndicatorText();

  els.actionStatusIndicator.classList.toggle("is-busy", isBusy);
  els.actionStatusIndicator.classList.toggle("is-available", Boolean(actionStatusState.owner));
  els.actionStatusIndicator.classList.toggle("has-text", Boolean(indicatorText));
  els.actionStatusIndicator.setAttribute("aria-disabled", String(!actionStatusState.owner));
  els.actionStatusIndicator.setAttribute(
    "aria-label",
    isBusy ? `Open action status: ${tooltip}` : tooltip
  );
  els.actionStatusIndicator.title = tooltip;

  if (els.actionStatusIndicatorGlyph) {
    els.actionStatusIndicatorGlyph.classList.toggle("is-spinning", isBusy);
  }

  if (els.actionStatusIndicatorLabel) {
    els.actionStatusIndicatorLabel.textContent = indicatorText;
  }
}

function getReducedActionStatusText() {
  const elapsed = actionStatusState.startedAt
    ? `Elapsed: ${formatElapsedMs(Date.now() - actionStatusState.startedAt)}`
    : "Elapsed: 0s";
  const message = actionStatusState.detail || actionStatusState.title || "Waiting for the next step...";
  return `${elapsed} - ${message}`;
}

function renderActionStatus() {
  if (!els.actionStatus || !els.actionStatusReduced) return;

  const hasOwner = Boolean(actionStatusState.owner);
  const showExpanded = hasOwner && actionStatusState.visible;
  const showReduced = hasOwner && !actionStatusState.visible;

  els.actionStatus.hidden = !showExpanded;
  els.actionStatusReduced.hidden = !showReduced;
  document.body.classList.toggle("has-reduced-status", showReduced);

  if (!hasOwner) {
    stopActionStatusTicking();
    renderActionStatusIndicator();
    return;
  }

  if (showExpanded) {
    els.actionStatus.dataset.tone = actionStatusState.tone;
    els.actionStatusPill.textContent = actionStatusState.label;
    els.actionStatusTitle.textContent = actionStatusState.title;
    els.actionStatusDetail.textContent = actionStatusState.detail;
    els.actionStatusHint.textContent = actionStatusState.hint;
    els.actionStatusElapsed.textContent = actionStatusState.startedAt
      ? `Elapsed: ${formatElapsedMs(Date.now() - actionStatusState.startedAt)}`
      : "Elapsed: 0s";
  }

  if (showReduced) {
    els.actionStatusReduced.dataset.tone = actionStatusState.tone;
    els.actionStatusReducedText.textContent = getReducedActionStatusText();
  }

  if (actionStatusState.startedAt) {
    ensureActionStatusTicking();
  } else {
    stopActionStatusTicking();
  }

  renderActionStatusIndicator();
}

function resetActionStatus() {
  clearActionStatusHideTimer();
  clearBackgroundStatusShowTimer();
  stopActionStatusTicking();
  actionStatusState.visible = false;
  actionStatusState.dismissed = false;
  actionStatusState.owner = null;
  actionStatusState.startedAt = null;
  renderActionStatus();
}

function dismissActionStatus() {
  clearActionStatusHideTimer();
  clearBackgroundStatusShowTimer();
  actionStatusState.visible = false;
  actionStatusState.dismissed = true;
  renderActionStatus();
}

function scheduleActionStatusHide(delayMs = ACTION_STATUS_HIDE_DELAY_MS) {
  clearActionStatusHideTimer();
  actionStatusHideTimer = setTimeout(() => {
    resetActionStatus();
  }, delayMs);
}

function beginActionStatus(title, detail, hint = "Live updates are shown here while the SDK is working.") {
  clearBackgroundStatusShowTimer();
  clearActionStatusHideTimer();
  actionStatusState.visible = true;
  actionStatusState.dismissed = false;
  actionStatusState.owner = "action";
  actionStatusState.tone = "working";
  actionStatusState.label = "Action in progress";
  actionStatusState.title = title;
  actionStatusState.detail = detail;
  actionStatusState.hint = hint;
  actionStatusState.startedAt = Date.now();
  renderActionStatus();
}

function updateActionStatus(detail, hint = actionStatusState.hint) {
  if (actionStatusState.owner !== "action") return;
  actionStatusState.detail = detail;
  actionStatusState.hint = hint;
  renderActionStatus();
}

function finishActionStatus(tone, detail, hint, hideDelayMs = ACTION_STATUS_HIDE_DELAY_MS) {
  if (!actionStatusState.owner) return;
  actionStatusState.tone = tone;
  actionStatusState.label = tone === "success" ? "Action complete" : "Action failed";
  actionStatusState.detail = detail;
  actionStatusState.hint = hint;
  if (tone === "error") {
    actionStatusState.visible = true;
    actionStatusState.dismissed = false;
  }
  renderActionStatus();
  scheduleActionStatusHide(hideDelayMs);
}

function completeActionStatus(detail, hint = "The UI will keep polling and update queue state when new data arrives.") {
  finishActionStatus("success", detail, hint);
}

function failActionStatus(detail, hint = "Check the activity log below if you need the full technical error.") {
  finishActionStatus("error", detail, hint);
}

function beginBackgroundStatus(
  title,
  detail,
  hint = "Background bridge sync is running. You can still submit a new action if needed.",
  { delayMs = 0 } = {}
) {
  if (actionInFlight) return;

  const show = () => {
    if (actionInFlight) return;
    clearActionStatusHideTimer();
    actionStatusState.visible = true;
    actionStatusState.dismissed = false;
    actionStatusState.owner = "background";
    actionStatusState.tone = "working";
    actionStatusState.label = "Background sync";
    actionStatusState.title = title;
    actionStatusState.detail = detail;
    actionStatusState.hint = hint;
    actionStatusState.startedAt = Date.now();
    renderActionStatus();
  };

  clearBackgroundStatusShowTimer();
  if (delayMs > 0) {
    backgroundStatusShowTimer = setTimeout(() => {
      backgroundStatusShowTimer = null;
      show();
    }, delayMs);
    return;
  }

  show();
}

function updateBackgroundStatus(detail, hint = actionStatusState.hint) {
  if (actionStatusState.owner !== "background") return;
  actionStatusState.detail = detail;
  actionStatusState.hint = hint;
  renderActionStatus();
}

function completeBackgroundStatus(
  detail,
  hint = "The latest bridge state has been loaded.",
  hideDelayMs = 2200
) {
  clearBackgroundStatusShowTimer();
  if (actionStatusState.owner !== "background") return;
  finishActionStatus("success", detail, hint, hideDelayMs);
}

function failBackgroundStatus(
  detail,
  hint = "Background sync hit an error. You can still inspect the log or try a manual refresh.",
  hideDelayMs = ACTION_STATUS_HIDE_DELAY_MS
) {
  clearBackgroundStatusShowTimer();
  if (actionStatusState.owner !== "background") return;
  finishActionStatus("error", detail, hint, hideDelayMs);
}

function updateVisibleStatus(detail, hint = actionStatusState.hint) {
  if (!actionStatusState.owner) return;

  if (actionStatusState.owner === "action") {
    updateActionStatus(detail, hint);
    return;
  }

  if (actionStatusState.owner === "background") {
    updateBackgroundStatus(detail, hint);
  }
}

function revealActionStatus() {
  if (!actionStatusState.owner) return;
  actionStatusState.visible = true;
  actionStatusState.dismissed = false;
  renderActionStatus();
}

function maybeAutoReduceActionStatus() {
  if (!actionStatusState.owner || !actionStatusState.visible) return;

  const scrollTop = window.scrollY || window.pageYOffset || 0;
  const viewportBottom = scrollTop + window.innerHeight;
  const documentHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );

  if (viewportBottom >= documentHeight - ACTION_STATUS_AUTO_REDUCE_BOTTOM_THRESHOLD_PX) {
    dismissActionStatus();
  }
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

function formatWalletNetwork(networkId) {
  const labels = {
    "mina:devnet": "Mina Devnet",
    "mina:testnet": "Mina Testnet",
    "mina:mainnet": "Mina Mainnet",
    "zeko:testnet": "Zeko Testnet",
    "zeko:mainnet": "Zeko Mainnet"
  };

  return labels[networkId] ?? networkId ?? "Unknown";
}

async function refreshWalletNetwork() {
  if (!account) {
    walletNetwork = null;
    renderTopStatus();
    return null;
  }

  try {
    walletNetwork = await getCurrentNetwork();
  } catch {
    walletNetwork = null;
  }

  renderTopStatus();
  return walletNetwork;
}

function loadPreferences() {
  const s = loadState();
  return s.preferences && typeof s.preferences === "object" ? s.preferences : {};
}

function savePreferences(preferences) {
  const s = loadState();
  saveState({ ...s, preferences: { ...loadPreferences(), ...preferences } });
}

function getBridgeNetworkSelectionMode() {
  const mode = loadPreferences().bridgeNetworkSelectionMode;
  return mode === BRIDGE_NETWORK_SELECTION_MANUAL
    ? BRIDGE_NETWORK_SELECTION_MANUAL
    : BRIDGE_NETWORK_SELECTION_AUTO;
}

function populateBridgeNetworkSelector() {
  if (!els.bridgeNetwork) return;

  const currentNetworkId = getCurrentBridgeNetworkId();
  els.bridgeNetwork.innerHTML = getBridgeNetworkOptions()
    .map(
      ({ id, label }) =>
        `<option value="${escapeHtml(id)}"${id === currentNetworkId ? " selected" : ""}>${escapeHtml(label)}</option>`
    )
    .join("");
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

function mapWalletNetworkToBridgeNetwork(networkId) {
  const mapping = {
    "mina:devnet": "testnet",
    "mina:testnet": "testnet",
    "zeko:testnet": "testnet",
    "mina:mainnet": "mainnet",
    "zeko:mainnet": "mainnet"
  };

  return mapping[networkId] ?? null;
}

function isDesktopLayout() {
  return forceDesktopMode || DESKTOP_MEDIA_QUERY.matches;
}

function syncFullscreenState() {
  const cards = document.querySelectorAll(".card");
  const isFocused = Boolean(fullscreenCardId) && isDesktopLayout();

  document.body.classList.toggle("card-focus-mode", isFocused);

  cards.forEach((card) => {
    const isCurrent = isFocused && card.dataset.cardId === fullscreenCardId;
    card.classList.toggle("is-fullscreen", isCurrent);

    const expandButton = card.querySelector('[data-role="expand"]');
    const reduceButton = card.querySelector('[data-role="reduce"]');

    if (expandButton) expandButton.hidden = !isDesktopLayout() || isCurrent;
    if (reduceButton) reduceButton.hidden = !isCurrent;
  });
}

function updateDesktopScale() {
  const isMobileWidth = !DESKTOP_MEDIA_QUERY.matches;
  const shouldScaleDesktop = forceDesktopMode && isMobileWidth && !fullscreenCardId;

  document.body.classList.toggle("mobile-desktop-scaled", shouldScaleDesktop);

  if (!shouldScaleDesktop) {
    document.body.style.removeProperty("--desktop-scale");
    document.body.style.removeProperty("min-height");
    return;
  }

  const availableWidth = Math.max(window.innerWidth - 32, 320);
  const scale = Math.min(availableWidth / DESKTOP_BASE_WIDTH, 1);
  const scaledHeight = Math.ceil(document.documentElement.scrollHeight * scale);

  document.body.style.setProperty("--desktop-scale", String(scale));
  document.body.style.minHeight = `${Math.max(window.innerHeight, scaledHeight)}px`;
}

function getAdjacentCardId(direction) {
  if (!fullscreenCardId || !orderedCardIds.length) return null;

  const currentIndex = orderedCardIds.indexOf(fullscreenCardId);
  if (currentIndex === -1) return null;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= orderedCardIds.length) return null;
  return orderedCardIds[nextIndex];
}

function setFullscreenCard(cardId) {
  fullscreenCardId = cardId;
  syncFullscreenState();
  updateDesktopScale();
}

function applyDesktopMode() {
  document.body.classList.toggle("force-desktop", forceDesktopMode);

  if (els.toggleDesktopMode) {
    els.toggleDesktopMode.classList.toggle("is-active", forceDesktopMode);
    els.toggleDesktopMode.setAttribute("aria-pressed", String(forceDesktopMode));
    els.toggleDesktopMode.setAttribute(
      "aria-label",
      forceDesktopMode ? "Disable desktop mode" : "Enable desktop mode"
    );
    els.toggleDesktopMode.title = forceDesktopMode
      ? "Disable forced desktop layout"
      : "Force desktop layout, including on mobile";
  }

  if (els.desktopModeIcon) {
    els.desktopModeIcon.innerHTML = forceDesktopMode ? ICONS.desktop : ICONS.mobile;
  }

  if (!isDesktopLayout() && fullscreenCardId) {
    fullscreenCardId = null;
  }

  syncFullscreenState();
  updateDesktopScale();
}

function setForceDesktopMode(enabled) {
  forceDesktopMode = Boolean(enabled);
  applyDesktopMode();
}

function applyThemeMode() {
  document.documentElement.setAttribute("data-theme", themeMode);

  if (els.toggleThemeMode) {
    const isDark = themeMode === "dark";
    els.toggleThemeMode.classList.toggle("is-active", isDark);
    els.toggleThemeMode.setAttribute("aria-pressed", String(isDark));
    els.toggleThemeMode.setAttribute(
      "aria-label",
      isDark ? "Activate light mode" : "Activate dark mode"
    );
    els.toggleThemeMode.title = isDark ? "Activate light mode" : "Activate dark mode";
  }

  if (els.themeModeIcon) {
    els.themeModeIcon.innerHTML = themeMode === "dark" ? ICONS.dark : ICONS.light;
  }
}

function setThemeMode(nextTheme) {
  themeMode = nextTheme === "dark" ? "dark" : "light";
  savePreferences({ theme: themeMode });
  applyThemeMode();
}

function createCardActionButton(label, role, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-action-button";
  button.dataset.role = role;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function initializeCardControls() {
  const cards = document.querySelectorAll(".card");
  orderedCardIds = [];

  cards.forEach((card, index) => {
    if (card.dataset.cardId) return;

    const cardId = `card-${index + 1}`;
    card.dataset.cardId = cardId;
    orderedCardIds.push(cardId);

    const actionWrap = document.createElement("div");
    actionWrap.className = "card-action-wrap";

    const expandButton = createCardActionButton("Expand", "expand", () => setFullscreenCard(cardId));
    const reduceButton = createCardActionButton("Reduce", "reduce", () => setFullscreenCard(null));

    actionWrap.append(expandButton, reduceButton);

    const heading = card.querySelector(".section-heading");
    if (heading) {
      heading.append(actionWrap);
    } else {
      actionWrap.classList.add("card-action-wrap--floating");
      card.prepend(actionWrap);
    }
  });

  applyDesktopMode();
}

function handleFullscreenGestureEnd(endX, endY) {
  if (!touchGestureStart || !fullscreenCardId) return;

  const deltaX = endX - touchGestureStart.x;
  const deltaY = endY - touchGestureStart.y;
  touchGestureStart = null;

  if (Math.abs(deltaX) < 72) return;
  if (Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;

  const nextCardId = deltaX < 0 ? getAdjacentCardId(1) : getAdjacentCardId(-1);
  if (!nextCardId) return;

  setFullscreenCard(nextCardId);
}

function handlePointerGestureEnd(endX, endY) {
  if (!pointerGestureStart || !fullscreenCardId) return;

  const deltaX = endX - pointerGestureStart.x;
  const deltaY = endY - pointerGestureStart.y;
  pointerGestureStart = null;

  if (Math.abs(deltaX) < 96) return;
  if (Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;

  const nextCardId = deltaX < 0 ? getAdjacentCardId(1) : getAdjacentCardId(-1);
  if (!nextCardId) return;

  setFullscreenCard(nextCardId);
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

function estimateDepositLabel(deposit, isClaimableNow = false) {
  if (deposit.finalised) return "Claimed";
  if (deposit.cancelled) return "Canceled";
  if (isClaimableNow) return "Claimable now";
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
  if (els.walletNetwork) {
    els.walletNetwork.textContent = account ? formatWalletNetwork(walletNetwork) : "Unknown";
  }
  els.connectionStatus.textContent = account ? "Wallet connected" : "Wallet disconnected";
  els.connectionStatus.classList.toggle("connected", Boolean(account));
  els.pollingStatus.textContent = pollTimer ? "Running" : "Stopped";
  els.lastRefresh.textContent = formatDateTime(uiState.lastRefreshAt);
  if (els.bridgeNetwork) {
    els.bridgeNetwork.value = getCurrentBridgeNetworkId();
  }
}

function pickNextClaimableDeposit(state, caps = uiState.depositCapabilities) {
  if (!state?.deposits?.length || !caps?.canFinalize) return null;

  if (Number.isInteger(caps?.finalizeIndex)) {
    return state.deposits.find((d) => d.index === caps.finalizeIndex) ?? null;
  }

  return [...state.deposits]
    .filter((d) => d.confirmed && !d.finalised && !d.cancelled)
    .sort((a, b) => a.index - b.index)[0] ?? null;
}

function pickNextCancellableDeposit(state, caps = uiState.depositCapabilities) {
  if (!state?.deposits?.length || !caps?.canCancel) return null;

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

const queueExpansionState = {
  deposit: {},
  withdrawal: {}
};

function resetQueueState() {
  uiState.depositState = null;
  uiState.depositCapabilities = null;
  uiState.withdrawalState = null;
  uiState.withdrawalCapabilities = null;
  uiState.lastRefreshAt = null;
  renderAll();
}

function applyBridgeNetworkLocally(nextNetworkId, { selectionMode } = {}) {
  bridgeNetworkGeneration += 1;
  refreshGeneration += 1;
  bridge = null;
  setBridgeNetwork(nextNetworkId);
  const preferenceUpdate = { bridgeNetwork: nextNetworkId };
  if (selectionMode) {
    preferenceUpdate.bridgeNetworkSelectionMode = selectionMode;
  }
  savePreferences(preferenceUpdate);
  populateBridgeNetworkSelector();
  resetQueueState();
  renderTopStatus();
}

function alignBridgeNetworkToWalletIfNeeded() {
  if (!walletNetwork) return false;
  if (getBridgeNetworkSelectionMode() === BRIDGE_NETWORK_SELECTION_MANUAL) {
    return false;
  }

  const inferredBridgeNetwork = mapWalletNetworkToBridgeNetwork(walletNetwork);
  if (!inferredBridgeNetwork || inferredBridgeNetwork === getCurrentBridgeNetworkId()) {
    return false;
  }

  applyBridgeNetworkLocally(inferredBridgeNetwork, {
    selectionMode: BRIDGE_NETWORK_SELECTION_AUTO
  });
  log(
    `Aligned bridge network to ${getCurrentBridgePreset().label} from wallet network ${formatWalletNetwork(walletNetwork)}.`
  );
  return true;
}

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

function isDepositDone(deposit) {
  return Boolean(deposit?.finalised || deposit?.cancelled);
}

function isWithdrawalDone(withdrawal) {
  return Boolean(withdrawal?.finalised);
}

function getVisibleQueueItems(items, isDone) {
  const sorted = [...items].sort((a, b) => a.index - b.index);
  const activeItems = sorted.filter((item) => !isDone(item));

  if (activeItems.length >= MAX_VISIBLE_QUEUE_HISTORY_ITEMS) {
    return activeItems;
  }

  const doneItems = sorted.filter((item) => isDone(item));
  const trailingDoneItems = doneItems.slice(-(MAX_VISIBLE_QUEUE_HISTORY_ITEMS - activeItems.length));
  return [...activeItems, ...trailingDoneItems].sort((a, b) => a.index - b.index);
}

function isQueueItemExpanded(queueType, itemIndex, isDone) {
  const storedValue = queueExpansionState[queueType]?.[itemIndex];
  if (typeof storedValue === "boolean") {
    return storedValue;
  }
  return !isDone;
}

function toggleQueueItemExpansion(queueType, itemIndex, isDone) {
  queueExpansionState[queueType][itemIndex] = !isQueueItemExpanded(queueType, itemIndex, isDone);
  renderAll();
}

function getDepositCurrentStatus(deposit, { isClaimableNow = false, isCancellableNow = false } = {}) {
  if (deposit.finalised) return { label: "Claimed", tone: "ok" };
  if (deposit.cancelled) return { label: "Canceled", tone: "warn" };
  if (isClaimableNow) return { label: "Claimable now", tone: "claimable" };
  if (isCancellableNow) return { label: "Cancellable now", tone: "warn" };
  if (deposit.confirmed) return { label: "Confirmed", tone: "ok" };
  if (deposit.accepted) return { label: "Accepted", tone: "ok" };
  if (deposit.synced) return { label: "Synced", tone: "ok" };
  return { label: "Queued", tone: "dim" };
}

function getWithdrawalCurrentStatus(withdrawal, { isFinalizableNow = false } = {}) {
  if (withdrawal.finalised) return { label: "Finalized", tone: "ok" };
  if (isFinalizableNow) return { label: "Finalizable now", tone: "claimable" };
  if (withdrawal.committed) return { label: "Committed", tone: "ok" };
  return { label: "Queued", tone: "dim" };
}

function renderCurrentStatusBadge(status) {
  return `<span class="badge ${status.tone}">${escapeHtml(status.label)}</span>`;
}

function renderQueueDepositCards() {
  const state = uiState.depositState;
  const caps = uiState.depositCapabilities;
  const nextClaimable = pickNextClaimableDeposit(state, caps);
  const nextCancellable = pickNextCancellableDeposit(state, caps);

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
      const isClaimableNow = caps?.canFinalize && d.index === nextClaimableIndex;

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
            <div><strong>Estimate:</strong> ${estimateDepositLabel(d, isClaimableNow)}</div>
          </div>

          <div class="queue-badges">
            ${isClaimableNow ? '<span class="badge claimable">claimable now</span>' : ""}
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

function renderQueueDepositCardsUpdated() {
  const state = uiState.depositState;
  const caps = uiState.depositCapabilities;
  const nextClaimable = pickNextClaimableDeposit(state, caps);
  const nextCancellable = pickNextCancellableDeposit(state, caps);

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

  const html = getVisibleQueueItems(state.deposits, isDepositDone)
    .map((d) => {
      const recipient = d.recipient?.toBase58?.() ?? String(d.recipient);
      const amount = d.amount?.toString?.() ?? String(d.amount);
      const timeout = d.timeout?.toString?.() ?? String(d.timeout);
      const holder = d.holderAccountL1?.toBase58?.() ?? String(d.holderAccountL1);
      const isClaimableNow = caps?.canFinalize && d.index === nextClaimableIndex;
      const isCancellableNow = caps?.canCancel && d.index === nextCancellableIndex;
      const isNextAction = d.index === nextClaimableIndex || d.index === nextCancellableIndex;
      const isDone = isDepositDone(d);
      const isExpanded = isQueueItemExpanded("deposit", d.index, isDone);
      const currentStatus = getDepositCurrentStatus(d, { isClaimableNow, isCancellableNow });

      const classes = [
        "queue-item",
        isNextAction ? "next-action" : "",
        !isDone && !d.accepted && d.synced ? "warning" : "",
        isDone ? "done" : "",
        !isExpanded ? "is-collapsed" : ""
      ]
        .filter(Boolean)
        .join(" ");

      const titleBadges = [
        d.index === nextClaimableIndex ? '<span class="badge claimable">next claimable</span>' : "",
        d.index === nextCancellableIndex ? '<span class="badge warn">next cancellable</span>' : ""
      ]
        .filter(Boolean)
        .join("");

      return `
        <div class="${classes}">
          <button
            class="queue-toggle"
            type="button"
            data-queue-type="deposit"
            data-queue-index="${d.index}"
            data-queue-done="${isDone}"
            aria-expanded="${isExpanded}"
          >
            <span class="queue-toggle-main">
              <span class="queue-title">Deposit #${d.index}</span>
              ${titleBadges}
            </span>
            <span class="queue-toggle-side">
              ${renderCurrentStatusBadge(currentStatus)}
              <span class="queue-toggle-label">${isExpanded ? "Hide" : "Show"}</span>
            </span>
          </button>

          <div class="queue-detail"${isExpanded ? "" : " hidden"}>
            <div class="queue-grid">
              <div><strong>Amount:</strong> ${formatMinaFromNanoLike(amount)} MINA</div>
              <div><strong>Recipient:</strong> ${shortPk(recipient)}</div>
              <div><strong>Holder:</strong> ${shortPk(holder)}</div>
              <div><strong>Timeout:</strong> ${timeout}</div>
              <div><strong>Hash:</strong> ${renderHashValue(d.hash)}</div>
              <div><strong>Timestamp:</strong> ${formatChainTimestamp(d.timestamp)}</div>
              <div><strong>Estimate:</strong> ${estimateDepositLabel(d, isClaimableNow)}</div>
            </div>

            <div class="queue-badges">
              ${isClaimableNow ? '<span class="badge claimable">claimable now</span>' : ""}
              ${isCancellableNow ? '<span class="badge warn">cancellable now</span>' : ""}
              <span class="badge ${d.synced ? "ok" : "dim"}">synced: ${d.synced}</span>
              <span class="badge ${d.accepted ? "ok" : "warn"}">accepted: ${d.accepted}</span>
              <span class="badge ${d.confirmed ? "ok" : "dim"}">confirmed: ${d.confirmed}</span>
              <span class="badge ${d.finalised ? "ok" : "dim"}">finalised: ${d.finalised}</span>
              <span class="badge ${d.cancelled ? "warn" : "dim"}">cancelled: ${d.cancelled}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  els.depositQueue.innerHTML = html;
}

function renderQueueWithdrawalCards() {
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

  const html = getVisibleQueueItems(state.withdrawals, isWithdrawalDone)
    .map((w) => {
      const recipient = w.recipient?.toBase58?.() ?? String(w.recipient);
      const amount = w.amount?.toString?.() ?? String(w.amount);
      const isNextAction = w.index === nextFinalizableIndex;
      const isDone = isWithdrawalDone(w);
      const isExpanded = isQueueItemExpanded("withdrawal", w.index, isDone);
      const isFinalizableNow = w.index === nextFinalizableIndex;
      const currentStatus = getWithdrawalCurrentStatus(w, { isFinalizableNow });

      const classes = [
        "queue-item",
        isNextAction ? "next-action" : "",
        isDone ? "done" : "",
        !isExpanded ? "is-collapsed" : ""
      ]
        .filter(Boolean)
        .join(" ");

      return `
        <div class="${classes}">
          <button
            class="queue-toggle"
            type="button"
            data-queue-type="withdrawal"
            data-queue-index="${w.index}"
            data-queue-done="${isDone}"
            aria-expanded="${isExpanded}"
          >
            <span class="queue-toggle-main">
              <span class="queue-title">Withdrawal #${w.index}</span>
              ${w.index === nextFinalizableIndex ? '<span class="badge claimable">next finalizable</span>' : ""}
            </span>
            <span class="queue-toggle-side">
              ${renderCurrentStatusBadge(currentStatus)}
              <span class="queue-toggle-label">${isExpanded ? "Hide" : "Show"}</span>
            </span>
          </button>

          <div class="queue-detail"${isExpanded ? "" : " hidden"}>
            <div class="queue-grid">
              <div><strong>Amount:</strong> ${formatMinaFromNanoLike(amount)} MINA</div>
              <div><strong>Recipient:</strong> ${shortPk(recipient)}</div>
              <div><strong>Hash:</strong> ${renderHashValue(w.hash)}</div>
              <div><strong>Timestamp:</strong> ${formatChainTimestamp(w.timestamp)}</div>
              <div><strong>Estimate:</strong> ${estimateWithdrawalLabel(w)}</div>
            </div>

            <div class="queue-badges">
              ${isFinalizableNow ? '<span class="badge claimable">finalizable now</span>' : ""}
              <span class="badge ${w.committed ? "ok" : "dim"}">committed: ${w.committed}</span>
              <span class="badge ${w.finalised ? "ok" : "dim"}">finalised: ${w.finalised}</span>
            </div>
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
            <div class="queue-grid local-history-grid">
              <div class="history-field"><strong>Time:</strong> ${safeText(h.time)}</div>
              <div class="history-field"><strong>Hash:</strong> ${renderHashValue(h.hash)}</div>
              <div class="history-field"><strong>Amount:</strong> ${safeText(h.amount)}</div>
              <div class="history-field"><strong>Fee:</strong> ${safeText(h.fee)}</div>
              <div class="history-field"><strong>Memo:</strong> ${safeText(h.memo)}</div>
            <div class="history-field history-field-error"><strong>Error:</strong> ${safeText(h.error)}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderAll() {
  renderTopStatus();
  renderQueueDepositCardsUpdated();
  renderQueueWithdrawalCards();
  renderLocalHistory();
  renderActionStatus();
}

function extractBridgeResultHash(result) {
  if (typeof result === "string") return result;

  return (
    result?.hash ||
    result?.transactionHash ||
    result?.txHash ||
    result?.id ||
    null
  );
}

async function initializeBridge({ generation = bridgeNetworkGeneration } = {}) {
  const preset = getCurrentBridgePreset();
  log(`Initializing bridge for ${preset.label}...`);
  updateVisibleStatus(`Initializing the ${preset.label} bridge configuration.`);
  const nextBridge = await initBridge();

  if (generation !== bridgeNetworkGeneration) {
    log(`Discarded stale ${preset.label} bridge initialization.`);
    return null;
  }

  bridge = nextBridge;
  if (!bridge) throw new Error("Bridge.init returned null/undefined");
  log(`Bridge initialized for ${preset.label}`);
  log("outerHolders:", bridge.outerHolders ?? []);
  return bridge;
}

async function ensureBridgeInitialized({ generation = bridgeNetworkGeneration } = {}) {
  if (bridge) return bridge;
  requireConnected();
  return await initializeBridge({ generation });
}

async function refreshQueues({ generation = refreshGeneration, networkGeneration = bridgeNetworkGeneration } = {}) {
  requireConnected();
  updateVisibleStatus("Refreshing bridge queue state.");
  await ensureBridgeInitialized({ generation: networkGeneration });
  requireBridge();

  const [depositState, depositCapabilities, withdrawalState, withdrawalCapabilities] =
    await Promise.all([
      fetchDepositStates(bridge, account),
      getDepositCapabilities(bridge, account),
      fetchWithdrawalStates(bridge, account),
      getWithdrawalCapabilities(bridge, account)
    ]);

  if (generation !== refreshGeneration) {
    return false;
  }

  uiState.depositState = depositState;
  uiState.depositCapabilities = depositCapabilities;
  uiState.withdrawalState = withdrawalState;
  uiState.withdrawalCapabilities = withdrawalCapabilities;
  uiState.lastRefreshAt = new Date().toISOString();

  renderAll();
  return true;
}

async function pollOnce() {
  if (pollingInFlight || actionInFlight) return;
  pollingInFlight = true;
  beginBackgroundStatus(
    "Refreshing bridge queues",
    "Fetching the latest deposits and withdrawals in the background.",
    "This sync is informative only. You can still launch a deposit or withdrawal once polling is idle.",
    { delayMs: 1400 }
  );

  try {
    await refreshQueues();
    completeBackgroundStatus("Background queue sync completed.");
  } catch (error) {
    failBackgroundStatus(error?.message || String(error));
    log("Polling error:", error?.message || error);
    console.error(error);
  } finally {
    clearBackgroundStatusShowTimer();
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

async function safelyRefreshBeforeAction(generation = refreshGeneration) {
  updateActionStatus("Refreshing queue state before continuing.");
  await refreshQueues({ generation });
}

async function waitForPollingIdle(timeoutMs = POLLING_DRAIN_TIMEOUT_MS) {
  if (!pollingInFlight) return;

  log("Waiting for polling to finish before action...");
  updateActionStatus("Waiting for background polling to finish.");
  const startedAt = Date.now();

  while (pollingInFlight) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Polling did not finish within ${Math.round(timeoutMs / 1000)}s. Try again in a moment.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runBridgeAction(actionName, callback, statusConfig = {}) {
  if (actionInFlight) {
    throw new Error(`Another bridge action is already in progress. Please wait before starting ${actionName}.`);
  }

  beginActionStatus(
    statusConfig.title ?? actionName,
    statusConfig.detail ?? "Preparing the action.",
    statusConfig.hint
  );

  const shouldResumePolling = Boolean(pollTimer);
  if (shouldResumePolling) {
    stopPolling();
  }

  refreshGeneration += 1;
  actionInFlight = true;
  try {
    const result = await callback(refreshGeneration);
    if (actionStatusState.visible && actionStatusState.tone === "working") {
      completeActionStatus(`${statusConfig.title ?? actionName} completed.`);
    }
    return result;
  } finally {
    actionInFlight = false;
    await refreshWalletNetwork();
    if (shouldResumePolling) {
      startPolling();
    }
  }
}

async function handleBridgeNetworkChange(nextNetworkId) {
  if (actionInFlight) {
    throw new Error("Cannot change bridge network while a bridge action is in progress.");
  }

  if (nextNetworkId === getCurrentBridgeNetworkId()) return;

  const shouldResumePolling = Boolean(pollTimer);
  if (shouldResumePolling) {
    stopPolling();
  }

  applyBridgeNetworkLocally(nextNetworkId, {
    selectionMode: BRIDGE_NETWORK_SELECTION_MANUAL
  });

  const preset = getCurrentBridgePreset();
  log(`Switched bridge network to ${preset.label}.`);

  if (!account) {
    renderTopStatus();
    return;
  }

  await ensureBridgeInitialized({ generation: bridgeNetworkGeneration });
  await refreshQueues({
    generation: refreshGeneration,
    networkGeneration: bridgeNetworkGeneration
  });

  if (shouldResumePolling) {
    startPolling();
  }
}

els.connect.addEventListener("click", async () => {
  try {
    beginBackgroundStatus(
      "Connecting wallet",
      "Connecting the wallet, initializing the bridge, and loading your queue.",
      "This can take a moment the first time because the bridge configuration and queue state must be loaded."
    );
    account = await connectWallet();
    await refreshWalletNetwork();
    alignBridgeNetworkToWalletIfNeeded();
    log("Connected:", account);

    await ensureBridgeInitialized();
    await refreshQueues();
    completeBackgroundStatus("Wallet connected and bridge state loaded.");
    startPolling();
  } catch (error) {
    bridge = null;
    failBackgroundStatus(error?.message || error);
    renderTopStatus();
    log("Connect/init error:", error?.message || error);
    console.error(error);
  }
});

els.refreshState.addEventListener("click", async () => {
  try {
    if (actionInFlight) {
      log("Refresh skipped because a bridge action is in progress.");
      return;
    }
    beginBackgroundStatus(
      "Refreshing state",
      "Updating deposits, withdrawals, and bridge capabilities.",
      "This refresh does not block normal usage for long, but large histories can take extra time."
    );
    await ensureBridgeInitialized();
    await refreshQueues();
    completeBackgroundStatus("Bridge state refreshed successfully.");
    log("State refreshed");
  } catch (error) {
    failBackgroundStatus(error?.message || error);
    log("Refresh error:", error?.message || error);
    console.error(error);
  }
});

els.startPolling.addEventListener("click", () => {
  (async () => {
    try {
      await ensureBridgeInitialized();
      requireBridge();
      startPolling();
    } catch (error) {
      log("Start polling error:", error?.message || error);
    }
  })();
});

els.stopPolling.addEventListener("click", () => {
  stopPolling();
});

els.bridgeNetwork?.addEventListener("change", () => {
  (async () => {
    const selectedNetworkId = els.bridgeNetwork?.value;
    if (!selectedNetworkId) return;

    try {
      await handleBridgeNetworkChange(selectedNetworkId);
    } catch (error) {
      populateBridgeNetworkSelector();
      renderTopStatus();
      log("Bridge network switch error:", error?.message || error);
      console.error(error);
    }
  })();
});

els.deposit.addEventListener("click", async () => {
  try {
    await runBridgeAction("deposit submission", async (actionGeneration) => {
      requireConnected();
      await ensureBridgeInitialized();
      requireBridge();

      const amount = els.amount.value;
      const fee = els.fee.value;
      const preset = getCurrentBridgePreset();
      updateActionStatus(`Preparing a deposit of ${amount} MINA on ${preset.label}.`);
      const signTransaction = createWalletTransactionSigner({
        fee,
        memo: "zeko-deposit",
        requiredNetwork: preset.l1WalletNetwork
      });

      log("Submitting deposit through bridge SDK...");
      updateActionStatus("Waiting for wallet approval and deposit submission.");
      const result = await submitDepositTx(bridge, account, amount, fee, signTransaction);
      const hash = extractBridgeResultHash(result);

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
      updateActionStatus("Deposit submitted. Refreshing queue state.");
      await refreshQueues({ generation: actionGeneration });
      completeActionStatus("Deposit submitted successfully and queue state refreshed.");
      startPolling();
    }, {
      title: "Deposit to Zeko",
      detail: "Preparing your deposit request.",
      hint: "You may need to approve or sign the transaction in your wallet."
    });
  } catch (error) {
    failActionStatus(error?.message || String(error));
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
    await runBridgeAction("withdrawal submission", async (actionGeneration) => {
      requireConnected();
      await ensureBridgeInitialized();
      requireBridge();

      const amount = els.amount.value;
      const fee = els.fee.value;
      const preset = getCurrentBridgePreset();
      updateActionStatus(`Preparing a withdrawal of ${amount} MINA on ${preset.label}.`);
      const signTransaction = createWalletTransactionSigner({
        fee,
        memo: "zeko-withdraw",
        requiredNetwork: preset.l2WalletNetwork
      });

      log("Submitting withdrawal through bridge SDK...");
      updateActionStatus("Waiting for wallet approval and withdrawal submission.");
      const result = await submitWithdrawalTx(bridge, account, amount, fee, signTransaction);
      const hash = extractBridgeResultHash(result);

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
      updateActionStatus("Withdrawal submitted. Refreshing queue state.");
      await refreshQueues({ generation: actionGeneration });
      completeActionStatus("Withdrawal submitted successfully and queue state refreshed.");
      startPolling();
    }, {
      title: "Withdraw to Mina",
      detail: "Preparing your withdrawal request.",
      hint: "You may need to approve or sign the transaction in your wallet."
    });
  } catch (error) {
    failActionStatus(error?.message || String(error));
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
    await runBridgeAction("deposit finalization", async (actionGeneration) => {
      requireConnected();
      await ensureBridgeInitialized();
      requireBridge();

      await safelyRefreshBeforeAction(actionGeneration);

      const caps = uiState.depositCapabilities;
      const nextClaimable = pickNextClaimableDeposit(uiState.depositState, caps);

      if (!caps?.canFinalize || !nextClaimable) {
        log("No claimable deposit available after refresh.");
        completeActionStatus("No claimable deposit is available right now.", "The queue was refreshed successfully.");
        return;
      }

      const fee = els.fee.value;
      const preset = getCurrentBridgePreset();
      updateActionStatus(`Preparing claim for deposit #${nextClaimable.index}.`);
      const signTransaction = createWalletTransactionSigner({
        fee,
        memo: "zeko-finalize-deposit",
        requiredNetwork: preset.l2WalletNetwork
      });

      log("Claiming next eligible deposit...", {
        sdkTargetIndex: nextClaimable.index,
        amount: nextClaimable.amount.toString(),
        hash: nextClaimable.hash
      });

      updateActionStatus("Waiting for wallet approval and deposit claim submission.");
      const result = await buildFinalizeDepositTx(bridge, account, fee, signTransaction);
      const hash = extractBridgeResultHash(result);

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
      updateActionStatus("Claim submitted. Refreshing queue state.");
      await refreshQueues({ generation: actionGeneration });
      completeActionStatus("Deposit claim submitted successfully and queue state refreshed.");
    }, {
      title: "Claim deposit",
      detail: "Checking the next claimable deposit.",
      hint: "Claims can take a while because the bridge may need to prepare proof data."
    });
  } catch (error) {
    const message = error?.message || String(error);
    failActionStatus(message);

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
        updateActionStatus("Refreshing queue state after a transient claim error.");
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
    await runBridgeAction("deposit cancellation", async (actionGeneration) => {
      requireConnected();
      await ensureBridgeInitialized();
      requireBridge();

      await safelyRefreshBeforeAction(actionGeneration);

      const caps = uiState.depositCapabilities;
      const nextCancellable = pickNextCancellableDeposit(uiState.depositState, caps);

      if (!caps?.canCancel || !nextCancellable) {
        log("No cancellable deposit available after refresh.");
        completeActionStatus("No cancellable deposit is available right now.", "The queue was refreshed successfully.");
        return;
      }

      const fee = els.fee.value;
      const preset = getCurrentBridgePreset();
      updateActionStatus(`Preparing cancellation for deposit #${nextCancellable.index}.`);
      const signTransaction = createWalletTransactionSigner({
        fee,
        memo: "zeko-cancel-deposit",
        requiredNetwork: preset.l1WalletNetwork
      });

      log("Cancelling next eligible deposit...", {
        sdkTargetIndex: nextCancellable.index,
        amount: nextCancellable.amount.toString(),
        hash: nextCancellable.hash
      });

      updateActionStatus("Waiting for wallet approval and deposit cancellation.");
      const result = await buildCancelDepositTx(bridge, account, fee, signTransaction);
      const hash = extractBridgeResultHash(result);

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
      updateActionStatus("Cancellation submitted. Refreshing queue state.");
      await refreshQueues({ generation: actionGeneration });
      completeActionStatus("Deposit cancellation submitted successfully and queue state refreshed.");
    }, {
      title: "Cancel deposit",
      detail: "Checking the next cancellable deposit.",
      hint: "This action submits a cancellation request through your wallet."
    });
  } catch (error) {
    const message = error?.message || String(error);
    failActionStatus(message);

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
        updateActionStatus("Refreshing queue state after a transient cancellation error.");
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
    await runBridgeAction("withdrawal finalization", async (actionGeneration) => {
      requireConnected();
      await ensureBridgeInitialized();
      requireBridge();

      await safelyRefreshBeforeAction(actionGeneration);

      const caps = uiState.withdrawalCapabilities;
      const nextFinalizable = pickNextFinalizableWithdrawal(uiState.withdrawalState);

      if (!caps?.canFinalize || !nextFinalizable) {
        log("No finalizable withdrawal available after refresh.");
        completeActionStatus("No finalizable withdrawal is available right now.", "The queue was refreshed successfully.");
        return;
      }

      const fee = els.fee.value;
      const preset = getCurrentBridgePreset();
      updateActionStatus(`Preparing finalization for withdrawal #${nextFinalizable.index}.`);
      const signTransaction = createWalletTransactionSigner({
        fee,
        memo: "zeko-finalize-withdrawal",
        requiredNetwork: preset.l1WalletNetwork
      });

      log("Finalizing next eligible withdrawal...", {
        sdkTargetIndex: nextFinalizable.index,
        amount: nextFinalizable.amount.toString(),
        hash: nextFinalizable.hash
      });

      updateActionStatus("Waiting for wallet approval and withdrawal finalization.");
      const result = await buildFinalizeWithdrawalTx(bridge, account, fee, signTransaction);
      const hash = extractBridgeResultHash(result);

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
      updateActionStatus("Finalization submitted. Refreshing queue state.");
      await refreshQueues({ generation: actionGeneration });
      completeActionStatus("Withdrawal finalization submitted successfully and queue state refreshed.");
    }, {
      title: "Finalize withdrawal",
      detail: "Checking the next finalizable withdrawal.",
      hint: "Finalization can take longer because bridge proof data may still be catching up."
    });
  } catch (error) {
    const message = error?.message || String(error);
    failActionStatus(message);

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
        updateActionStatus("Refreshing queue state after a transient finalize error.");
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

els.actionStatusClose?.addEventListener("click", () => {
  dismissActionStatus();
});

els.actionStatusIndicator?.addEventListener("click", () => {
  if (actionStatusState.visible) {
    dismissActionStatus();
    return;
  }
  revealActionStatus();
});

els.actionStatusReduced?.addEventListener("click", () => {
  revealActionStatus();
});

els.depositQueue?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-queue-type='deposit']");
  if (!button) return;

  const itemIndex = Number(button.getAttribute("data-queue-index"));
  const isDone = button.getAttribute("data-queue-done") === "true";
  if (!Number.isInteger(itemIndex)) return;

  toggleQueueItemExpansion("deposit", itemIndex, isDone);
});

els.withdrawalQueue?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-queue-type='withdrawal']");
  if (!button) return;

  const itemIndex = Number(button.getAttribute("data-queue-index"));
  const isDone = button.getAttribute("data-queue-done") === "true";
  if (!Number.isInteger(itemIndex)) return;

  toggleQueueItemExpansion("withdrawal", itemIndex, isDone);
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

document.addEventListener(
  "touchstart",
  (event) => {
    if (!fullscreenCardId || event.touches.length !== 1) {
      touchGestureStart = null;
      return;
    }

    const fullscreenCard = event.target.closest(".card.is-fullscreen");
    if (!fullscreenCard) {
      touchGestureStart = null;
      return;
    }

    const touch = event.touches[0];
    touchGestureStart = { x: touch.clientX, y: touch.clientY };
  },
  { passive: true }
);

document.addEventListener(
  "touchend",
  (event) => {
    if (!touchGestureStart || !fullscreenCardId) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    handleFullscreenGestureEnd(touch.clientX, touch.clientY);
  },
  { passive: true }
);

document.addEventListener("touchcancel", () => {
  touchGestureStart = null;
});

document.addEventListener("pointerdown", (event) => {
  if (!fullscreenCardId) {
    pointerGestureStart = null;
    return;
  }

  if (event.pointerType === "touch") return;
  if (event.button !== 0) {
    pointerGestureStart = null;
    return;
  }

  const fullscreenCard = event.target.closest(".card.is-fullscreen");
  if (!fullscreenCard) {
    pointerGestureStart = null;
    return;
  }

  pointerGestureStart = { x: event.clientX, y: event.clientY };
});

document.addEventListener("pointerup", (event) => {
  if (!pointerGestureStart || event.pointerType === "touch") return;
  handlePointerGestureEnd(event.clientX, event.clientY);
});

document.addEventListener("pointercancel", () => {
  pointerGestureStart = null;
});

els.toggleDesktopMode?.addEventListener("click", () => {
  setForceDesktopMode(!forceDesktopMode);
});

els.toggleThemeMode?.addEventListener("click", () => {
  setThemeMode(themeMode === "dark" ? "light" : "dark");
});

if (typeof DESKTOP_MEDIA_QUERY.addEventListener === "function") {
  DESKTOP_MEDIA_QUERY.addEventListener("change", applyDesktopMode);
} else if (typeof DESKTOP_MEDIA_QUERY.addListener === "function") {
  DESKTOP_MEDIA_QUERY.addListener(applyDesktopMode);
}

window.addEventListener("resize", updateDesktopScale);
window.addEventListener("scroll", maybeAutoReduceActionStatus, { passive: true });
window.addEventListener("resize", maybeAutoReduceActionStatus);

(async function boot() {
  try {
    const savedNetworkId = loadPreferences().bridgeNetwork;
    if (savedNetworkId) {
      setBridgeNetwork(savedNetworkId);
    }
    populateBridgeNetworkSelector();
    applyThemeMode();
    initializeCardControls();
    renderAll();

    const existing = await getConnectedAccount();
    if (existing) {
      beginBackgroundStatus(
        "Restoring session",
        "Reconnecting the wallet session and loading bridge data.",
        "Saved wallet sessions may still need a fresh bridge initialization and queue sync."
      );
      account = existing;
      await refreshWalletNetwork();
      alignBridgeNetworkToWalletIfNeeded();
      log("Wallet already connected:", existing);

      await ensureBridgeInitialized();
      await refreshQueues();
      completeBackgroundStatus("Session restored and bridge state loaded.");
      startPolling();
    }
  } catch (error) {
    failBackgroundStatus(error?.message || error);
    log("Boot info:", error?.message || error);
  }
})();
