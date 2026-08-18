# Retired experiments

This file preserves the conclusions from removed experiments without retaining
their competing executables, snapshots, model copies, and test surfaces.

## Board-only forward/reverse graph

The original proof of concept expanded exact forward positions and reverse
board/pass reachability. The forward graph continued growing without a useful
plateau. Reverse depth three reached many forward board/pass shapes but did not
reach the starting state, and an intersection was only reachability: omitted
history and White's adversarial branches meant it could not certify a win.

The later symmetry work safely accelerated pure Go-rule operations, but the
opponent AI is orientation sensitive. Symmetric boards could not be merged, and
the optimization did not change the fundamental state-space result.

The source, executables, snapshots, reverse caches, Metal support probe, and
large collision audits for this path were removed. Do not revive it as a proof
engine unless a new design supplies exact-history AND/OR certificates and a
measured state-space collapse.

## Global seeded graph

A process-wide graph intended to merge all phase roots was retired. Exact
superko histories and timing provenance made eager cross-root merging risky and
memory-heavy. The retained design proves each phase/root independently, then
deduplicates only validated certificate states during packing.

## Full 19×19 playbook and rolling WebGPU search

A complete World Daemon playbook is not practical. A real-time bounded search
also failed to provide the required reliable improvement within the decision
deadline. Exact correction records showed insufficient reusable overlap to
justify a large orientation/phase-specific table.

The copied 19×19 checkpoint, strict-K=1 harness, counterfactual sheet, and
WebGPU rolling-search POC were experiments tied to an outdated model. They were
removed so this directory cannot silently freeze or override the current model
being trained under `go-ai/`.

The supported 19×19 direction is neural-first: collect useful bounded-search or
cheat-created corrections, distill them through DAgger/recovery training, then
quantize and promote through the normal neural pipeline. Any optional runtime
cheat sheet must be keyed to the promoted model and justified by paired held-out
win improvement.

## Architectural rule

`ipvgobruteforce/` owns certified 5×5 playbook generation and packing. Neural
models and training remain outside it. This boundary is deliberate: experiments
may consume a current model through an explicit interface, but must not create
a second model authority here.
