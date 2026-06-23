import { fetchAccount, Transaction } from "o1js";

const MINA_DECIMALS = 1_000_000_000n;
const NETWORK_GRAPHQL_ENDPOINTS = {
  "mina:devnet": "https://gateway.mina.devnet.zeko.io",
  "mina:testnet": "https://gateway.mina.devnet.zeko.io",
  "mina:mainnet": "https://gateway.mina.mainnet.zeko.io/",
  "zeko:testnet": "https://testnet.zeko.io/graphql",
  "zeko:mainnet": "https://mainnet.zeko.io/graphql"
};

export function getMinaProvider() {
  if (typeof window === "undefined" || !window.mina) {
    throw new Error("No Mina wallet found. Install a zkApp-compatible wallet such as Auro.");
  }
  return window.mina;
}

function getProviderDiagnostics(mina) {
  if (!mina || typeof mina !== "object") {
    return "provider unavailable";
  }

  const methodNames = listProviderMethodNames(mina)
    .sort();

  const providerName =
    mina.name ||
    mina.provider ||
    mina.walletName ||
    mina.constructor?.name ||
    "unknown-wallet";

  return `provider=${providerName}; methods=${methodNames.join(", ") || "none"}`;
}

function listProviderMethodNames(mina) {
  const methodNames = new Set();
  let current = mina;

  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string") continue;
      if (key === "constructor") continue;

      try {
        if (typeof mina[key] === "function") {
          methodNames.add(key);
        }
      } catch {
        // Ignore getters that throw.
      }
    }

    current = Object.getPrototypeOf(current);
  }

  return [...methodNames];
}

function getProviderMethod(mina, methodName) {
  try {
    return typeof mina?.[methodName] === "function" ? mina[methodName].bind(mina) : null;
  } catch {
    return null;
  }
}

function hasProviderMethod(mina, methodName) {
  return Boolean(getProviderMethod(mina, methodName));
}

async function callProviderRequest(mina, methodCandidates, payload) {
  const request = getProviderMethod(mina, "request");
  if (!request) return { ok: false };

  let lastError = null;

  for (const method of methodCandidates) {
    try {
      const params =
        payload === undefined
          ? { method }
          : { method, params: payload };

      return { ok: true, value: await request(params) };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return { ok: false };
}

async function callProvider(mina, directMethodCandidates, requestMethodCandidates, payload) {
  for (const methodName of directMethodCandidates) {
    const method = getProviderMethod(mina, methodName);
    if (!method) continue;
    return await method(payload);
  }

  const requestResult = await callProviderRequest(mina, requestMethodCandidates, payload);
  if (requestResult.ok) {
    return requestResult.value;
  }

  throw new Error(
    `Provider method not available. direct=${directMethodCandidates.join(", ")} request=${requestMethodCandidates.join(", ")}`
  );
}

const NETWORK_ALIASES = {
  "mina:devnet": ["mina:devnet", "mina:testnet"],
  "mina:testnet": ["mina:testnet", "mina:devnet"],
  "mina:mainnet": ["mina:mainnet"],
  "zeko:testnet": ["zeko:testnet"],
  "zeko:mainnet": ["zeko:mainnet"]
};

function getAcceptedNetworkIds(networkId) {
  return NETWORK_ALIASES[networkId] ?? [networkId];
}

function normalizeNetworkId(payload) {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  return payload.networkID ?? payload.networkId ?? payload.chainId ?? null;
}

function normalizeAccountsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (typeof payload === "string") return [payload];
  return [];
}

function formatNanoBalanceToMinaString(value) {
  const raw = typeof value === "bigint" ? value : BigInt(value?.toString?.() ?? value ?? 0);
  const whole = raw / MINA_DECIMALS;
  const fraction = raw % MINA_DECIMALS;

  if (fraction === 0n) {
    return whole.toString();
  }

  return `${whole}.${fraction.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

function matchesNetwork(currentNetwork, requiredNetwork) {
  if (!currentNetwork || !requiredNetwork) return false;
  return getAcceptedNetworkIds(requiredNetwork).includes(currentNetwork);
}

export async function getCurrentNetwork() {
  const mina = getMinaProvider();
  const result = await callProvider(
    mina,
    ["requestNetwork"],
    ["mina_requestNetwork", "requestNetwork"],
    undefined
  );
  return result?.networkID ?? null;
}

export async function ensureNetwork(requiredNetwork) {
  if (!requiredNetwork) return null;

  const mina = getMinaProvider();
  const currentNetwork = await getCurrentNetwork();

  if (matchesNetwork(currentNetwork, requiredNetwork)) {
    return currentNetwork;
  }

  if (typeof mina.switchChain !== "function") {
    const hasRequest = Boolean(getProviderMethod(mina, "request"));
    if (!hasRequest) {
      throw new Error(
        `Wallet is connected to ${currentNetwork || "an unknown network"}, but ${requiredNetwork} is required and automatic switching is not supported.`
      );
    }
  }

  const switchResult = await callProvider(
    mina,
    ["switchChain"],
    ["mina_switchChain", "switchChain"],
    { networkID: requiredNetwork }
  );
  const switchedNetwork = switchResult?.networkID ?? (await getCurrentNetwork());

  if (!matchesNetwork(switchedNetwork, requiredNetwork)) {
    throw new Error(
      `Failed to switch wallet to ${requiredNetwork}. Current network is ${switchedNetwork || "unknown"}.`
    );
  }

  return switchedNetwork;
}

export async function connectWallet() {
  const mina = getMinaProvider();
  const accounts = await callProvider(
    mina,
    ["requestAccounts"],
    ["mina_requestAccounts", "requestAccounts"],
    undefined
  );

  if (!accounts || !accounts.length) {
    throw new Error("No account returned by wallet.");
  }

  return accounts[0];
}

export async function getConnectedAccount() {
  const mina = getMinaProvider();
  const accounts = await callProvider(
    mina,
    ["getAccounts"],
    ["mina_accounts", "getAccounts"],
    undefined
  ).catch(() => null);
  return accounts?.[0] ?? null;
}

export async function getAccountBalance(account, networkId) {
  if (!account || !networkId) return null;

  const graphqlEndpoint = NETWORK_GRAPHQL_ENDPOINTS[networkId];
  if (!graphqlEndpoint) {
    throw new Error(`Unsupported wallet network for balance lookup: ${networkId}`);
  }

  const result = await fetchAccount({ publicKey: account }, graphqlEndpoint);

  if (result?.error) {
    throw new Error(result.error.message ?? String(result.error));
  }

  const balance = result?.account?.balance;
  if (!balance) {
    return "0";
  }

  return formatNanoBalanceToMinaString(balance.toBigInt?.() ?? balance.toString?.() ?? balance);
}

function registerProviderListener(mina, eventName, listener) {
  const on = getProviderMethod(mina, "on") ?? getProviderMethod(mina, "addListener");
  if (!on) return () => {};

  on(eventName, listener);

  const off = getProviderMethod(mina, "off") ?? getProviderMethod(mina, "removeListener");
  if (!off) return () => {};
  return () => off(eventName, listener);
}

export function subscribeToWalletChanges({ onAccountsChanged, onNetworkChanged } = {}) {
  const mina = getMinaProvider();
  const unsubscribeFns = [];

  if (typeof onAccountsChanged === "function") {
    const accountsListener = (payload) => onAccountsChanged(normalizeAccountsPayload(payload));
    unsubscribeFns.push(registerProviderListener(mina, "accountsChanged", accountsListener));
  }

  if (typeof onNetworkChanged === "function") {
    const networkListener = (payload) => onNetworkChanged(normalizeNetworkId(payload));
    unsubscribeFns.push(registerProviderListener(mina, "networkChanged", networkListener));
    unsubscribeFns.push(registerProviderListener(mina, "chainChanged", networkListener));
  }

  return () => {
    for (const unsubscribe of unsubscribeFns) {
      try {
        unsubscribe();
      } catch {
        // Ignore provider unsubscription failures.
      }
    }
  };
}

function extractSignedTransactionPayload(result) {
  const candidates = [
    result?.signedData,
    result?.transaction,
    result?.signedTransaction,
    result?.data?.transaction,
    result?.data?.signedTransaction,
    result?.data?.signedData,
    result?.data,
    result
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (typeof candidate === "string") {
      return candidate;
    }

    if (
      typeof candidate === "object" &&
      ("accountUpdates" in candidate || "zkappCommand" in candidate || "feePayer" in candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

function normalizeSignedTransactionPayload(payload) {
  if (!payload) return null;

  let normalized = payload;

  if (typeof normalized === "string") {
    const trimmed = normalized.trim();

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        normalized = JSON.parse(trimmed);
      } catch {
        return payload;
      }
    } else {
      return payload;
    }
  }

  if (normalized?.data && typeof normalized.data === "object") {
    normalized = normalized.data;
  }

  if (
    normalized &&
    typeof normalized === "object" &&
    normalized.zkappCommand &&
    typeof normalized.zkappCommand === "object"
  ) {
    normalized = normalized.zkappCommand;
  }

  if (
    normalized &&
    typeof normalized === "object" &&
    normalized.feePayer &&
    normalized.accountUpdates
  ) {
    return normalized;
  }

  return payload;
}

export function createWalletTransactionSigner({
  fee,
  memo = "zeko-bridge",
  requiredNetwork
} = {}) {
  return async (tx) => {
    if (!tx || typeof tx.toJSON !== "function") {
      throw new Error("Missing or unsupported o1js transaction.");
    }

    if (requiredNetwork) {
      await ensureNetwork(requiredNetwork);
    }

    const mina = getMinaProvider();
    const signingPayload = {
      transaction: tx.toJSON(),
      feePayer: {
        fee,
        memo
      }
    };

    const canCallDirectSignTransaction = hasProviderMethod(mina, "signTransaction");
    const canCallSendTransaction =
      hasProviderMethod(mina, "sendTransaction") || hasProviderMethod(mina, "request");

    let signingResult;
    let signTransactionError = null;

    if (canCallDirectSignTransaction) {
      try {
        signingResult = await callProvider(
          mina,
          ["signTransaction"],
          ["mina_signTransaction", "signTransaction"],
          signingPayload
        );
      } catch (error) {
        signTransactionError = error;
      }
    }

    if (!signingResult && canCallSendTransaction) {
      try {
        signingResult = await callProvider(
          mina,
          ["sendTransaction"],
          ["mina_sendTransaction", "sendTransaction"],
          {
            ...signingPayload,
            onlySign: true
          }
        );
      } catch (fallbackError) {
        if (!canCallDirectSignTransaction) {
          try {
            signingResult = await callProvider(
              mina,
              [],
              ["mina_signTransaction", "signTransaction"],
              signingPayload
            );
          } catch (requestSignError) {
            throw new Error(
              `The connected Mina wallet does not support transaction signing. ${getProviderDiagnostics(mina)}. onlySign=${fallbackError?.message || fallbackError}; signTransaction=${requestSignError?.message || requestSignError}`
            );
          }
        } else {
          throw new Error(
            `The connected Mina wallet does not support transaction signing. ${getProviderDiagnostics(mina)}. signTransaction=${signTransactionError?.message || signTransactionError}; onlySign=${fallbackError?.message || fallbackError}`
          );
        }
      }
    }

    if (!signingResult && signTransactionError) {
      throw signTransactionError;
    }

    const signedPayload = extractSignedTransactionPayload(signingResult);
    if (!signedPayload) {
      throw new Error(
        `Wallet did not return a signed transaction payload. ${getProviderDiagnostics(mina)}`
      );
    }

    return Transaction.fromJSON(normalizeSignedTransactionPayload(signedPayload));
  };
}

export async function sendTransaction(tx, fee, memo = "zeko-bridge", options = {}) {
  if (!tx) {
    throw new Error("Missing transaction object.");
  }

  if (typeof tx.toJSON !== "function") {
    throw new Error("Unsupported transaction object: tx.toJSON() is missing.");
  }

  if (options.requiredNetwork) {
    await ensureNetwork(options.requiredNetwork);
  }

  const mina = getMinaProvider();
  const transactionJson = tx.toJSON();

  return await callProvider(
    mina,
    ["sendTransaction"],
    ["mina_sendTransaction", "sendTransaction"],
    {
      transaction: transactionJson,
      feePayer: {
        fee,
        memo
      }
    }
  );
}
