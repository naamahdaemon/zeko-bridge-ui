import { Bridge, diagnoseBridgeHistory } from "@zeko-labs/bridge-sdk";
import { PublicKey, UInt32, UInt64, fetchAccount, setGraphqlEndpoint } from "o1js";

const MINA = 1e9;
export const BRIDGE_NETWORK_PRESETS = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    l1WalletNetwork: "mina:mainnet",
    l2WalletNetwork: "zeko:mainnet",
    config: {
      l1Url: "https://api.minascan.io/node/mainnet/v1/graphql",
      l1ArchiveUrl: "https://api.minascan.io/archive/mainnet/v1/graphql",
      actionsApi: "https://api.actions.zeko.io/graphql",
      zekoUrl: "https://mainnet.zeko.io/graphql",
      zekoArchiveUrl: "https://archive.mainnet.zeko.io/graphql",
      l1Network: "mainnet",
      l2Network: "mainnet",
      pollTimeout: 1_200_000
    }
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    l1WalletNetwork: "mina:devnet",
    l2WalletNetwork: "zeko:testnet",
    config: {
      l1Url: "https://gateway.mina.devnet.zeko.io",
      l1ArchiveUrl: "https://gateway.mina.archive.devnet.zeko.io",
      actionsApi: "https://testnet.api.actions.zeko.io/graphql",
      zekoUrl: "https://testnet.zeko.io/graphql",
      zekoArchiveUrl: "https://archive.testnet.zeko.io/graphql",
      l1Network: "testnet",
      l2Network: "testnet",
      pollTimeout: 1_200_000
    }
  }
};

const DEFAULT_BRIDGE_NETWORK_ID = "mainnet";
let activeBridgeNetworkId = DEFAULT_BRIDGE_NETWORK_ID;
const DIAGNOSTICS_CACHE_TTL_MS = 60000;
const depositDiagnosticsCache = new Map();

function getBridgePresetOrThrow(networkId) {
  const preset = BRIDGE_NETWORK_PRESETS[networkId];
  if (!preset) {
    throw new Error(`Unsupported bridge network preset: ${networkId}`);
  }
  return preset;
}

function getBridgeConfig() {
  return getBridgePresetOrThrow(activeBridgeNetworkId).config;
}

export function getCurrentBridgeNetworkId() {
  return activeBridgeNetworkId;
}

export function getCurrentBridgePreset() {
  return getBridgePresetOrThrow(activeBridgeNetworkId);
}

export function getBridgeNetworkOptions() {
  return Object.values(BRIDGE_NETWORK_PRESETS).map(({ id, label }) => ({ id, label }));
}

export function setBridgeNetwork(networkId) {
  activeBridgeNetworkId = getBridgePresetOrThrow(networkId).id;
  depositDiagnosticsCache.clear();
}

function toNano(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid MINA amount: ${amount}`);
  }
  return Math.round(value * MINA);
}

function toNanoFee(fee) {
  const value = Number(fee);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid fee amount: ${fee}`);
  }
  return Math.round(value * MINA);
}

function toPublicKey(value) {
  return typeof value === "string" ? PublicKey.fromBase58(value) : value;
}

function toComparableString(value) {
  if (value === null || value === undefined) return "";
  return value.toBase58?.() ?? value.toString?.() ?? String(value);
}

function timestampWeight(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function pickPreferredWithdrawal(current, candidate) {
  const currentScore =
    (current.finalised ? 4 : 0) +
    (current.committed ? 2 : 0) +
    (timestampWeight(current.timestamp) > 0 ? 1 : 0);
  const candidateScore =
    (candidate.finalised ? 4 : 0) +
    (candidate.committed ? 2 : 0) +
    (timestampWeight(candidate.timestamp) > 0 ? 1 : 0);

  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  return timestampWeight(candidate.timestamp) > timestampWeight(current.timestamp) ? candidate : current;
}

function dedupeWithdrawals(withdrawals) {
  const deduped = new Map();

  for (const withdrawal of withdrawals ?? []) {
    const key = [
      toComparableString(withdrawal.hash),
      toComparableString(withdrawal.recipient),
      toComparableString(withdrawal.amount)
    ].join("|");

    const current = deduped.get(key);
    deduped.set(key, current ? pickPreferredWithdrawal(current, withdrawal) : withdrawal);
  }

  return [...deduped.values()];
}

function hasVerificationKeyLookupError(error) {
  return String(error?.message || error).includes("Verification key not found");
}

function describeVerificationKeyResult(result) {
  const base = `${result.label}=${result.publicKey}`;

  if (result.status === "ok") {
    return `${base} [vk ok: ${result.hash}]`;
  }

  if (result.status === "fetch-error") {
    return `${base} [fetch error: ${result.reason}]`;
  }

  return `${base} [${result.status}]`;
}

async function fetchVerificationKeyStatus(label, publicKey, graphqlEndpoint) {
  const publicKeyBase58 = toComparableString(publicKey);

  try {
    const result = await fetchAccount(
      { publicKey: publicKeyBase58 },
      graphqlEndpoint
    );

    if (result?.error) {
      return {
        label,
        publicKey: publicKeyBase58,
        endpoint: graphqlEndpoint,
        status: "fetch-error",
        reason: result.error.message ?? String(result.error)
      };
    }

    if (!result?.account) {
      return {
        label,
        publicKey: publicKeyBase58,
        endpoint: graphqlEndpoint,
        status: "missing-account"
      };
    }

    if (!result.account.zkapp) {
      return {
        label,
        publicKey: publicKeyBase58,
        endpoint: graphqlEndpoint,
        status: "not-zkapp"
      };
    }

    if (!result.account.zkapp.verificationKey) {
      return {
        label,
        publicKey: publicKeyBase58,
        endpoint: graphqlEndpoint,
        status: "missing-verification-key"
      };
    }

    return {
      label,
      publicKey: publicKeyBase58,
      endpoint: graphqlEndpoint,
      status: "ok",
      hash: result.account.zkapp.verificationKey.hash.toString()
    };
  } catch (error) {
    return {
      label,
      publicKey: publicKeyBase58,
      endpoint: graphqlEndpoint,
      status: "fetch-error",
      reason: error?.message ?? String(error)
    };
  }
}

async function warmAccountCache(checks, graphqlEndpoint) {
  setGraphqlEndpoint(graphqlEndpoint);
  await Promise.all(
    checks.map((check) =>
      fetchAccount(
        { publicKey: check.publicKey, tokenId: check.tokenId },
        graphqlEndpoint
      ).catch(() => null)
    )
  );
}

async function withVerificationKeyDiagnostics(actionLabel, graphqlEndpoint, checks, operation) {
  await warmAccountCache(checks, graphqlEndpoint);

  try {
    return await operation();
  } catch (error) {
    if (!hasVerificationKeyLookupError(error)) {
      throw error;
    }

    const diagnostics = await Promise.all(
      checks.map((check) =>
        fetchVerificationKeyStatus(check.label, check.publicKey, check.endpoint)
      )
    );

    const detail = diagnostics.map(describeVerificationKeyResult).join("; ");
    const endpoints = [...new Set(diagnostics.map((entry) => entry.endpoint))].join(", ");
    throw new Error(
      `${actionLabel}: Verification key not found. Checked ${endpoints}. ${detail}`
    );
  }
}

async function getDepositTimestampFallbacks(account) {
  const config = getBridgeConfig();
  const walletAddress = toComparableString(account);
  const cacheKey = `${activeBridgeNetworkId}:${walletAddress}`;
  const cached = depositDiagnosticsCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < DIAGNOSTICS_CACHE_TTL_MS) {
    return cached.timestampsByHash;
  }

  const diagnostics = await diagnoseBridgeHistory({
    config,
    walletAddress
  });

  const timestampsByHash = new Map(
    (diagnostics?.deposits?.entries ?? [])
      .filter((entry) => entry?.hash && timestampWeight(entry?.timestamp) > 0)
      .map((entry) => [entry.hash, entry.timestamp])
  );

  depositDiagnosticsCache.set(cacheKey, {
    fetchedAt: Date.now(),
    timestampsByHash
  });

  return timestampsByHash;
}

export async function initBridge() {
  return await Bridge.init(getBridgeConfig());
}

export async function submitDepositTx(bridge, account, amount, fee, signTransaction) {
  const config = getBridgeConfig();
  if (!bridge) throw new Error("Bridge is not initialized.");
  if (!bridge.outerHolders?.length) throw new Error("Bridge outerHolders are missing.");

  return await withVerificationKeyDiagnostics(
    "submitDeposit",
    config.l1Url,
    [
      { label: "outerPk", publicKey: bridge.outerPk, endpoint: config.l1Url },
      { label: "outerHolder", publicKey: bridge.outerHolders[0], endpoint: config.l1Url }
    ],
    () =>
      bridge.submitDeposit(
        {
          sender: PublicKey.fromBase58(account),
          fee: toNanoFee(fee)
        },
        {
          recipient: PublicKey.fromBase58(account),
          amount: UInt64.from(toNano(amount)),
          timeout: UInt32.MAXINT(),
          holderAccountL1: bridge.outerHolders[0]
        },
        signTransaction
      )
  );
}

export async function submitWithdrawalTx(bridge, account, amount, fee, signTransaction) {
  const config = getBridgeConfig();
  if (!bridge) throw new Error("Bridge is not initialized.");

  return await withVerificationKeyDiagnostics(
    "submitWithdrawal",
    config.zekoUrl,
    [
      { label: "innerHolder", publicKey: bridge.innerHolder, endpoint: config.zekoUrl },
      { label: "innerPk", publicKey: bridge.innerPk, endpoint: config.zekoUrl }
    ],
    () =>
      bridge.submitWithdrawal(
        {
          sender: PublicKey.fromBase58(account),
          fee: toNanoFee(fee)
        },
        {
          recipient: PublicKey.fromBase58(account),
          amount: UInt64.from(toNano(amount))
        },
        signTransaction
      )
  );
}

export async function fetchDepositStates(bridge, account) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  const state = await bridge.fetchDepositsWithStates(toPublicKey(account));
  const deposits = state?.deposits ?? [];

  if (!deposits.some((deposit) => timestampWeight(deposit?.timestamp) === 0 && deposit?.hash)) {
    return state;
  }

  try {
    const timestampsByHash = await getDepositTimestampFallbacks(account);

    return {
      ...state,
      deposits: deposits.map((deposit) => ({
        ...deposit,
        timestamp:
          timestampWeight(deposit?.timestamp) > 0
            ? deposit.timestamp
            : timestampsByHash.get(deposit.hash) ?? deposit.timestamp
      }))
    };
  } catch {
    return state;
  }
}

export async function fetchWithdrawalStates(bridge, account) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  const state = await bridge.fetchWithdrawalsWithStates(toPublicKey(account));

  return {
    ...state,
    withdrawals: dedupeWithdrawals(state?.withdrawals)
  };
}

export async function getDepositCapabilities(bridge, account) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  const pk = toPublicKey(account);

  const [finalizeResult, cancelResult] = await Promise.all([
    bridge.canFinalizeDeposit(pk),
    bridge.canCancelDeposit(pk)
  ]);

  return {
    canFinalize: Boolean(finalizeResult?.available),
    finalizeReason: finalizeResult?.reason ?? null,
    canCancel: Boolean(cancelResult?.available),
    cancelReason: cancelResult?.reason ?? null
  };
}

export async function getWithdrawalCapabilities(bridge, account) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  const pk = toPublicKey(account);

  const finalizeResult = await bridge.canFinalizeWithdrawal(pk);

  return {
    canFinalize: Boolean(finalizeResult?.available),
    finalizeReason: finalizeResult?.reason ?? null
  };
}

export async function buildFinalizeDepositTx(bridge, account, fee, signTransaction) {
  const config = getBridgeConfig();
  if (!bridge) throw new Error("Bridge is not initialized.");

  return await withVerificationKeyDiagnostics(
    "finalizeDeposit",
    config.zekoUrl,
    [
      { label: "innerHolder", publicKey: bridge.innerHolder, endpoint: config.zekoUrl }
    ],
    () =>
      bridge.finalizeDeposit(
        PublicKey.fromBase58(account),
        signTransaction,
        { feeNanomina: toNanoFee(fee) }
      )
  );
}

export async function buildCancelDepositTx(bridge, account, fee, signTransaction) {
  const config = getBridgeConfig();
  if (!bridge) throw new Error("Bridge is not initialized.");
  if (!bridge.outerHolders?.length) throw new Error("Bridge outerHolders are missing.");

  return await withVerificationKeyDiagnostics(
    "cancelDeposit",
    config.l1Url,
    [
      { label: "outerTokenOwner", publicKey: bridge.outerTokenOwner, endpoint: config.l1Url },
      { label: "outerHolder", publicKey: bridge.outerHolders[0], endpoint: config.l1Url }
    ],
    () =>
      bridge.cancelDeposit(
        PublicKey.fromBase58(account),
        signTransaction,
        bridge.outerHolders[0],
        { feeNanomina: toNanoFee(fee) }
      )
  );
}

export async function buildFinalizeWithdrawalTx(bridge, account, fee, signTransaction) {
  const config = getBridgeConfig();
  if (!bridge) throw new Error("Bridge is not initialized.");
  if (!bridge.outerHolders?.length) throw new Error("Bridge outerHolders are missing.");

  return await withVerificationKeyDiagnostics(
    "finalizeWithdrawal",
    config.l1Url,
    [
      { label: "outerTokenOwner", publicKey: bridge.outerTokenOwner, endpoint: config.l1Url },
      { label: "outerHolder", publicKey: bridge.outerHolders[0], endpoint: config.l1Url }
    ],
    () =>
      bridge.finalizeWithdrawal(
        PublicKey.fromBase58(account),
        signTransaction,
        bridge.outerHolders[0],
        { feeNanomina: toNanoFee(fee) }
      )
  );
}
