export function getMinaProvider() {
  if (typeof window === "undefined" || !window.mina) {
    throw new Error("No Mina wallet found. Install a zkApp-compatible wallet such as Auro.");
  }
  return window.mina;
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

export async function sendTransaction(tx, fee, memo = "zeko-bridge") {
  if (!tx) {
    throw new Error("Missing transaction object.");
  }

  if (typeof tx.toJSON !== "function") {
    throw new Error("Unsupported transaction object: tx.toJSON() is missing.");
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