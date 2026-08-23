import type { Server } from '@ns';
import {
  RamBroker,
  STUB_BASE_GB,
  type ArenaPlan,
  type BrokerHost,
  type BrokerRequest,
  type BrokerSnapshot,
} from '../../shared/ram/broker.ts';
import type { Heap } from '../../shared/ram/heap.ts';

export interface DodgeLease {
  host: string;
  release(): void;
}

export type DodgeAcquire = ({ status: 'placed' } & DodgeLease) | { status: 'queued' };

/** Build the broker's pure host view from state the controller already holds. */
export function brokerHosts(
  servers: Record<string, Server>,
  deployed: ReadonlySet<string>,
  heap?: Heap,
): BrokerHost[] {
  return Object.values(servers).map((server) => ({
    hostname: server.hostname,
    maxRam: server.maxRam,
    freeGb: heap?.host(server.hostname)
      ? heap.freeOn(server.hostname, true)
      : Math.max(0, server.maxRam - server.ramUsed),
    rooted: server.hasAdminRights,
    deployed: server.hostname === 'home' || deployed.has(server.hostname),
  }));
}

function requestKey(request: BrokerRequest): string {
  return `${request.by}\0${request.id}`;
}

/** Commit pure broker placements to the same Heap the farm allocates from. */
export class DodgeBrokerDriver {
  readonly broker = new RamBroker();
  #ready = new Map<string, { lease: DodgeLease; request: BrokerRequest; at: number }>();

  request(
    request: BrokerRequest,
    hosts: readonly BrokerHost[],
    heap: Heap | undefined,
    arena: ArenaPlan,
    now: number,
  ): DodgeAcquire {
    const ready = this.#ready.get(requestKey(request));
    if (ready) {
      this.#ready.delete(requestKey(request));
      if (ready.request.gb === request.gb) return { status: 'placed', ...ready.lease };
      ready.lease.release();
    }
    const decision = this.broker.request(request, hosts, arena, now);
    if (decision.status === 'queued') return { status: 'queued' };
    const lease = commitLease(heap, decision.host, STUB_BASE_GB + request.gb);
    if (lease) return { status: 'placed', ...lease };
    this.broker.enqueue(request, now);
    return { status: 'queued' };
  }

  /** A landing placement is leased immediately and made due. If its owner no
   * longer asks for it, the one-second ready window expires and drops it
   * instead of pinning that RAM (or a stale queue entry) indefinitely. */
  drain(hosts: readonly BrokerHost[], heap: Heap | undefined, arena: ArenaPlan, now: number): BrokerRequest[] {
    for (const [key, ready] of this.#ready) {
      if (now - ready.at < 1_000) continue;
      ready.lease.release();
      this.#ready.delete(key);
    }
    const ready: BrokerRequest[] = [];
    for (const decision of this.broker.drain(hosts, arena, now)) {
      const lease = commitLease(heap, decision.host, STUB_BASE_GB + decision.request.gb);
      if (!lease) {
        this.broker.enqueue(decision.request, now);
        continue;
      }
      this.#ready.set(requestKey(decision.request), { lease, request: decision.request, at: now });
      ready.push(decision.request);
    }
    return ready;
  }

  snapshot(now: number): BrokerSnapshot {
    return this.broker.snapshot(now);
  }
}

function commitLease(heap: Heap | undefined, host: string, gb: number): DodgeLease | undefined {
  if (!heap || heap.host(host) === undefined) return { host, release: () => {} };
  const lease = heap.reserveOn(host, gb, true);
  return lease ? { host, release: () => lease.release() } : undefined;
}
