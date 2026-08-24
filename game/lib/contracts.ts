import type { ContractOrigin } from "../../shared/telemetry/topics/side.ts";

export interface ContractQueueEntry {
  host: string;
  file: string;
  dnet?: { identity: string; observedAt: number };
}

export interface DarknetContractQueueEntry extends ContractQueueEntry {
  dnet: { identity: string; observedAt: number };
}

export interface DarknetContractListing {
  identity: string;
  observedAt: number;
  validUntil: number;
  files: string[];
}

export function contractKey(contract: Pick<ContractQueueEntry, "host" | "file">): string {
  return `${contract.host}\0${contract.file}`;
}

/** Where a contract came from. One helper so the probe, the driver and the
 * viewer cannot disagree about what counts as darknet work. */
export function contractOrigin(contract: Pick<ContractQueueEntry, "host" | "file"> & Partial<Pick<ContractQueueEntry, "dnet">>): ContractOrigin {
  return contract.dnet ? "darknet" : "network";
}

export function darknetContractIsActionable(
  contract: ContractQueueEntry,
  listings: Readonly<Record<string, DarknetContractListing>> | undefined,
  now: number,
): boolean {
  if (!contract.dnet) return true;
  const listing = listings?.[contract.host];
  return listing !== undefined
    && listing.observedAt === contract.dnet.observedAt
    && listing.identity === contract.dnet.identity
    && now <= listing.validUntil
    && listing.files.includes(contract.file);
}

/** Materialize every contract whose authoritative resident listing is fresh. */
export function darknetContractsFromListings(
  listings: Readonly<Record<string, DarknetContractListing>> | undefined,
  now: number,
): DarknetContractQueueEntry[] {
  const contracts: DarknetContractQueueEntry[] = [];
  for (const [host, listing] of Object.entries(listings ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    // The explicit identity check also rejects private state left by a build
    // that predates identity-bound listings.
    if (listing.identity === undefined || now > listing.validUntil) continue;
    for (const file of listing.files) {
      contracts.push({
        host,
        file,
        dnet: {
          identity: listing.identity,
          observedAt: listing.observedAt,
        },
      });
    }
  }
  return contracts;
}

export function pendingDarknetContracts(
  contracts: readonly DarknetContractQueueEntry[],
  handled: Readonly<Record<string, number>> | undefined,
  quarantine: Readonly<Record<string, unknown>> | undefined,
): DarknetContractQueueEntry[] {
  return contracts.filter((contract) => {
    const key = contractKey(contract);
    const handledAt = handled?.[key];
    return (handledAt === undefined || handledAt < contract.dnet.observedAt)
      && quarantine?.[key] === undefined;
  });
}

/** Darknet work leads; otherwise preserve discovery order and remove duplicates. */
export function mergeContractQueue(
  darknet: readonly ContractQueueEntry[],
  ordinary: readonly ContractQueueEntry[],
  limit: number,
): ContractQueueEntry[] {
  const result: ContractQueueEntry[] = [];
  const seen = new Set<string>();
  for (const source of [darknet, ordinary]) {
    for (const contract of source) {
      const key = contractKey(contract);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(contract);
      if (result.length >= limit) return result;
    }
  }
  return result;
}
