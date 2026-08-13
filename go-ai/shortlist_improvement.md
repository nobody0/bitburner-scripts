# V9 learned shortlist

V9 replaces the handwritten 19x19 shortlist with a policy-style head attached
to the shared full-resolution board trunk. It emits one logit per point plus
pass. Training also supervises thirteen candidate-response branch logits per
move; that auxiliary head is stripped from deployed artifacts because runtime
uses the exact rules and opponent predictor after shortlisting.

Training is exhaustive. `go_cpp_gpu_env ... v9` emits every legal Black move,
pass, and every weighted exact White reply/branch. `gpu/train_v9.py` uses a
frozen promoted V9 value teacher to form a complete ordering and quadratic-win
regret target. A dedicated exhaustive-best anchor loss ensures one dependable
move survives top K, while a separate four-move multilabel objective preserves
three diverse high-upside/bait candidates without forcing the four positives
to compete with one another.
The old ordered 96 is evaluated only to mark moves it would have hidden as
`bait`; it never filters V9 labels. Versioned gzip corpora pin the profile,
teacher SHA-256, and opponent oracle so expensive exhaustive labels can be
replayed safely.

Held-out gates measure top-K recall and regret separately for ordinary,
pass-best, and bait-best positions. A V9 actor or promotion is rejected until
the checkpoint hash and summary prove these gates passed. Even after that,
continuation still emits exhaustive proposal/branch supervision, so the model
cannot remove its misses from later training data.

At runtime the proposal runs on the original board for every reachable dispatch
seed. The engine reserves per-seed choices, aggregates scores, retains 8
finalists for either profile by default, and doubles K when the boundary is flat.
Only finalists run exact opponent prediction and post-response value inference.
Pass is a normal candidate. `candidateLimit: Infinity` is the exhaustive shadow
mode used for audits.

The behavior input contains the exact smart/reckless result, three remaining
WHRNG values, semantic priority precedence, and enabled fallback branches. It
does not contain raw faction identity and does not claim the final branch is
known before the candidate board exists. Small5 adds varying komi; daemon19
omits fixed komi. The immutable difficulty/Go Power multiplier is absent from
inputs and targets; the tie-break is loss-penalized raw Black score per round.

For daemon19, post-reply value evaluation uses neutral behavior because the
known current-turn RNG signature has already been consumed and there is only
one opponent. Candidate-independent conditioning remains on the proposal and
branch heads. Optional exhaustive candidate-ranking supervision trains the
value head to reproduce deployment ordering; win utility is quadratic, while
Power per total turn is linear and therefore prefers fewer turns.

The current paused trajectory and retained research checkpoints are documented
in [`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md). They are not promotion
evidence: current promotion still requires a V9-teacher summary that passes all
unseen shortlist gates.
