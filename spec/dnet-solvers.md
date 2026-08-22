# The password solvers

The darknet's 24 server models are the feature's whole difficulty. Five use
bounded dictionaries, eight decode from server details, and eleven require a
feedback conversation. This is the framework for the latter two groups, what
its contract promises, and how a solve survives losing the host it was talking
through. Everything here is `shared/strategy/dnet/solvers/`; the code is
pure and the job that drives it is `attemptJob` in `game/dnet/jobs.ts`.

For the models themselves — which is which, what each answers with, and the
difficulty tiers — see [dnet.md](dnet.md#the-24-server-models).

## Why a state machine and not a list

`planAttempt` (`shared/strategy/dnet/models.ts`) walks an ordered candidate list:
hand it a COUNT of how many have been ruled out and it returns the next one. That
is exactly right for the five dictionary models and useless for the rest, because
their attacks are conversations — send a guess, the host answers with something
*about* the guess, and the answer decides what to send next. A count has nowhere
to put the answer.

So a solver is `(facts, state, observation) -> step`, pure. Every completed
attempt and destructive log read writes through immediately to the target's
shared ledger; a worker never owns the conversation it is advancing.

## The contract

```ts
interface Solver {
  readonly needsOracle: boolean;
  budget(facts: PasswordFacts): number;
  first(facts: PasswordFacts): SolverStep;
  next(facts: PasswordFacts, state: SolverState, seen: SolverObservation): SolverStep;
}
```

- **`needsOracle`** says whether the solver reads the log ring at all. `false`
  means it works below the host's charisma requirement, because `heartbleed` is
  the only charisma-gated call and `authenticate` is not. Every closed-form model
  is `false`, which is a large part of why they are worth doing first. The
  per-step `needsOracle` on an `attempt` is what the job actually acts on; this
  flag is the pessimistic summary `planAttempt` reads to decide whether an
  attempt is worth filing at all.
- **`budget`** is the most attempts this solver may spend on one identity.
  Declared rather than discovered: every one of these converges eventually by
  brute force, so an undeclared budget is not a solver, it is a loop.
- **`first`/`next`** return a `SolverStep`, which is one of exactly three things:

| Step | Meaning |
|---|---|
| `answer` | The password is known. One `authenticate` should open the host — and if it does not, our decoding of this model is WRONG, which is worth hearing. |
| `attempt` | Send this, observe, come back with the state. |
| `give-up` | Stop, for a named reason. `state` is carried when the stop is resumable. |

`SolverState` is plain JSON — written to the ledger, folded by home, read back by
a different process on a different host — so nothing in it may be a closure, a
`Map` or a class instance. It carries `model`, an identity `fingerprint`, a
solver-defined `phase` the framework never interprets, `spent`, and `scratch`.

**`scratch` is a credential.** It accumulates resolved characters, known prefixes
and modular residues; late in a solve it IS the password. It must never reach a
topic or a log, and `stripCredentials` is the enforcement point.

## Resume: why a lost vantage does not lose the solve

The arithmetic that forces this. A round trip is `authenticate` plus a
`heartbleed` at 1.5x its time — about 3.3 s at one thread, near-flat across
progression. The ADJACENCY the conversation depends on lasts about 108 s
(`msPerHostEventAny(["moved", "disconnected"])`), so one vantage buys roughly
thirty exchanges, and several solvers need more. But the PASSWORD lasts far
longer: only deletion mints a new one (~576 s), and a move or a restart leaves it
alone.

So the state has to outlive the process holding the session, which is why it
lives in the overseer's knowledge — on the attempt ledger, which `foldReports`
drops only when a host reports absent.

**A state alone is not enough to resume.** The contract offers `first()` and
`next(state, observation)` and nothing in between, so what re-enters a
conversation is the ANSWER to the attempt the state was waiting on. The previous
job sent that attempt and died before hearing back, so the answer is what has to
be recovered — and re-sending the same password recovers it exactly, because
every model's response is a pure function of (password, attempt). That is one
exchange, against restarting a search that may have been thirty deep.

Two keys carry this, both in `solvers/types.ts`:

- **`PENDING_ATTEMPT`** (`"__pendingAttempt"`) holds that attempt, inside
  `scratch` so it travels with the state through the ledger and the fold without
  either having to know about it — and so `stripCredentials` redacts it along
  with everything else in there. A pending attempt is a guess at the password,
  and late in a solve that is very nearly the password. Solvers never see it:
  `withoutPending` removes it before the state is handed back to one.
- **`PENDING_NEEDS_ORACLE`** (`"__pendingNeedsOracle"`) records whether that
  exact step expected feedback. It cannot be reconstructed from the solver's
  global `needsOracle`: several solvers switch between feedback probes and
  candidate passwords. A resumed 408 retries the same attempt with the same
  channel requirement and remains uncharged.
- **`EXHAUSTED_PHASE`** (`"__exhausted"`) parks an identity whose search space is
  gone. Nothing else would stop it being retried: `planAttempt` calls `first()`
  fresh on every derivation, and the ledger's `lastCode` holds the engine's 401
  rather than our 910. Without the marker, an eliminated search is filed again
  on the next tick, for ever. It is a normal state, so it dies exactly when the
  identity does.

`resumableState(carried, modelId, facts)` is the one gate, and it checks three
things because each fails differently:

1. **The model must match** — and this is checked there rather than inside
   `stateMatches`, which recomputes the fingerprint from the state's own `model`
   and so can only confirm what the state already believes. Two models with the
   same length, the same format and no hint or data fingerprint identically
   (`AccountsManager_4.2` and `NIL` do), and feeding one solver's scratch to
   another does not fail politely: it spreads an `undefined` and THROWS, killing
   the agent process rather than failing the attempt.
2. **The identity must match**, or we resume onto a new password and never
   terminate. Hostnames are recycled upstream, so a ledger can outlive the
   machine it describes.
3. **A pending attempt must travel with it**, or there is no way back in and the
   solve restarts from `first()`.

**The budget bounds the resume.** A pending attempt is reconstructed as an
ordinary `attempt` step and re-enters the same exchange loop, whose budget,
deadline, cancellation, 408 retry and target-loss checks therefore apply before
and after it exactly as they do to a fresh step. The state remains resumable at
the cap, so a later budget change can pick the conversation back up.

## Giving up is a named outcome, not a silence

A solver that stops says which kind of stop it was, because "we ran out of
budget" (resume later), "the host stopped answering" (find another vantage) and
"we eliminated the whole search space" (our model of the game is WRONG) want
completely different responses. The codes live in `solvers/types.ts` as
`SOLVER_CODES`, continuing the local block in `courier.ts`, and they are ordered
by how loudly they should be read:

| Code | Name | What it means |
|---|---|---|
| 906 | `SolverBudget` | The declared budget ran out. State is kept; the next vantage resumes. Expected on the expensive models, and not a fault. |
| 907 | `SolverStalled` | A matched response taught us nothing new — usually a grammar parsed loosely enough to accept a line that says nothing. |
| 908 | `OracleUnavailable` | Feedback was needed and the ring could not be read: below the charisma gate, or `heartbleed` refused. Not the solver's fault, and it clears on its own. |
| 909 | `OracleUnparsed` | The response did not match the grammar this model is documented to speak. Upstream changed, or we transcribed it wrong. |
| 910 | `SolverExhausted` | The search space was eliminated with no hit: the password provably is not where our model says it must be. The loudest code here. |

The last two are not operational problems. They are evidence that our
transcription of the game is wrong, which is why they must never blend into the
first three.

## What drives it

`attemptJob` holds the whole conversation in ONE process, and that is deliberate:
one attempt per job would pay the 2.0 GB spawn tax and a full overseer tick per
guess, turning a nine-exchange solve into half a minute of scheduling. Inside it,
`send` is one `authenticate` plus the log read its real answer may be hiding in,
`resume` re-enters an unfinished conversation, and `converse` runs the exchanges
until the solver stops or the wall clock does.

The exception is `2G_cellular`: it needs no ring feedback, so its records may be
drained in a batch. Its timing baseline and one-correct-character delta are both
read from `formulas.dnet.getAuthenticateTime` with the attempt job's actual
thread count; hardcoding one thread changes the inferred prefix length.

`ATTEMPT_WALL_MS` (36 s) is not a taste decision: it is comfortably under the
~108 s a vantage lasts and well under `JOB_TIMEOUT_MS`, so the overseer never
times out a job that is working, and a job never converses with a host it can no
longer reach.

Two response codes are handled inside the loop rather than by the solver, because
neither says anything about the password: **408** fires after the delay and
before the model is consulted, so nothing was learned and the same step is
retried uncharged; **351/503** mean the host moved or went offline, so the state
is kept — the password has not changed, only our ability to reach it.

`tests/dnet-attempt-job.test.ts` drives the real bodies against the simulator's
feedback models, and `tests/dnet-solvers-vs-sim.test.ts` checks each solver
against the generator it is transcribed from.

## Failure guesses are chosen for what they teach

A wrong authentication is not merely a miss. Where the model has a patterned
response, the next attempt is selected for the partition that response creates:

- `AccountsManager_4.2` and ranged `BellaCuore` enumerate the still-admissible
  values when the range is bounded, discard candidates contradicted by harvested
  hints, and probe the median of what remains.
- `BigMo%od` asks the largest pairwise-coprime moduli first, so the CRT product
  grows faster. The simulator cost ratchet falls from nine calls to eight.
- `PHP 5.4` at the generator's real lengths (at most seven) keeps every
  evidence-compatible ordering and samples candidate probes for the smallest
  worst three-decimal RMS bucket. A correct probe opens immediately; a failure
  removes a whole bucket complement. Longer synthetic inputs retain the
  constant-time positional RMS equations rather than materialising factorially
  many orderings.

The generic log hints feed the same decisions. Contains hints prune finite
candidate sets and prioritize complete probe alphabets without removing symbols.
Placement hints fix a position only when its character occurred once in the
attempt—the log reports values, not indices, so repeated-character probes are
constraints but not coordinates. `NIL`, `DeepGreen`, `RateMyPix.Auth`, and
`2G_cellular` seed their known positions/prefix from those safe placements.
Their chosen alphabet is stored in solver state, preventing a later log drain
from reordering an in-progress conversation underneath its numeric cursor.
