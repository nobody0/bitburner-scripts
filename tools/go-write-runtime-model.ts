/** Materialize one committed runtime artifact as a temporary native checkpoint.
 * This is a tooling entrypoint for promotion gates, never a game entrypoint. */
import { DAEMON19_GO_MODEL } from "../shared/strategy/go/neural/models/daemon19.ts";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";
import { goRuntimeCheckpointText } from "./go-runtime-model.ts";

const [profile, target] = [Bun.argv[2], Bun.argv[3]];
if ((profile !== "small5" && profile !== "daemon19") || !target) {
  throw new Error("usage: bun run tools/go-write-runtime-model.ts <small5|daemon19> <target.model>");
}
await Bun.write(target, goRuntimeCheckpointText(profile === "small5" ? SMALL5_GO_MODEL : DAEMON19_GO_MODEL));
