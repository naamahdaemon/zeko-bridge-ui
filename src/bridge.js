import { Bridge } from "@zeko-labs/bridge-sdk";
import { PublicKey, UInt32, UInt64 } from "o1js";

const MINA = 1e9;

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

export async function initBridge() {
  return await Bridge.init({
    l1Url: "https://api.minascan.io/node/devnet/v1/graphql",
    l1ArchiveUrl: "https://api.minascan.io/archive/devnet/v1/graphql",
    actionsApi: "https://api.actions.zeko.io/graphql",
    zekoUrl: "https://testnet.zeko.io/graphql",
    zekoArchiveUrl: "https://archive.testnet.zeko.io/graphql",
    l1Network: "testnet",
    l2Network: "testnet",
    pollTimeout: 1_200_000
  });
}

export async function submitDepositTx(bridge, account, amount, fee) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  if (!bridge.outerHolders?.length) throw new Error("Bridge outerHolders are missing.");

  return await bridge.submitDeposit(
    {
      sender: PublicKey.fromBase58(account),
      fee: toNanoFee(fee)
    },
    {
      recipient: PublicKey.fromBase58(account),
      amount: UInt64.from(toNano(amount)),
      timeout: UInt32.MAXINT(),
      holderAccountL1: bridge.outerHolders[0]
    }
  );
}

export async function submitWithdrawalTx(bridge, account, amount, fee) {
  if (!bridge) throw new Error("Bridge is not initialized.");

  return await bridge.submitWithdrawal(
    {
      sender: PublicKey.fromBase58(account),
      fee: toNanoFee(fee)
    },
    {
      recipient: PublicKey.fromBase58(account),
      amount: UInt64.from(toNano(amount))
    }
  );
}

export async function fetchDepositStates(bridge, account) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  return await bridge.fetchDepositsWithStates(toPublicKey(account));
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

export async function buildFinalizeDepositTx(bridge, account, fee) {
  if (!bridge) throw new Error("Bridge is not initialized.");

  return await bridge.finalizeDeposit(
    PublicKey.fromBase58(account),
    UInt64.from(toNanoFee(fee))
  );
}

export async function buildCancelDepositTx(bridge, account, fee) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  if (!bridge.outerHolders?.length) throw new Error("Bridge outerHolders are missing.");

  return await bridge.cancelDeposit(
    PublicKey.fromBase58(account),
    {
      sender: PublicKey.fromBase58(account),
      fee: toNanoFee(fee)
    },
    bridge.outerHolders[0]
  );
}

export async function buildFinalizeWithdrawalTx(bridge, account, fee) {
  if (!bridge) throw new Error("Bridge is not initialized.");
  if (!bridge.outerHolders?.length) throw new Error("Bridge outerHolders are missing.");

  return await bridge.finalizeWithdrawal(
    PublicKey.fromBase58(account),
    {
      sender: PublicKey.fromBase58(account),
      fee: toNanoFee(fee)
    },
    bridge.outerHolders[0]
  );
}
