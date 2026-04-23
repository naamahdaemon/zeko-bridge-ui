export function getMinaProvider() {
  if (typeof window === "undefined" || !window.mina) {
    throw new Error("No Mina wallet found. Install a zkApp-compatible wallet such as Auro.");
  }
  return window.mina;
}

const NETWORK_ALIASES = {
  "mina:devnet": ["mina:devnet", "mina:testnet"],
  "mina:testnet": ["mina:testnet", "mina:devnet"],
  "zeko:testnet": ["zeko:testnet"]
};

function getAcceptedNetworkIds(networkId) {
  return NETWORK_ALIASES[networkId] ?? [networkId];
}

function matchesNetwork(currentNetwork, requiredNetwork) {
  if (!currentNetwork || !requiredNetwork) return false;
  return getAcceptedNetworkIds(requiredNetwork).includes(currentNetwork);
}

export async function getCurrentNetwork() {
  const mina = getMinaProvider();
  const result = await mina.requestNetwork?.();
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
    throw new Error(
      `Wallet is connected to ${currentNetwork || "an unknown network"}, but ${requiredNetwork} is required and automatic switching is not supported.`
    );
  }

  const switchResult = await mina.switchChain({ networkID: requiredNetwork });
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
  const accounts = await mina.requestAccounts();

  if (!accounts || !accounts.length) {
    throw new Error("No account returned by wallet.");
  }

  return accounts[0];
}

export async function getConnectedAccount() {
  const mina = getMinaProvider();
  const accounts = await mina.getAccounts?.();
  return accounts?.[0] ?? null;
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

  return await mina.sendTransaction({
    transaction: transactionJson,
    feePayer: {
      fee,
      memo
    }
  });
}
