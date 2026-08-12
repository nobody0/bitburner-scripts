import { PORT_OPENER_PROGRAMS, programCreateTimeMs } from "../../shared/strategy/career/programs.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";

/** CreateProgramWork for the port-opening programs used by the controller.
 * Work is one-shot, occupies Player.currentWork, survives ordinary controller
 * passes, and only creates the file when the full work unit is banked. */
export class ProgramSystem {
  #world: SimWorld;
  #player: SimPlayer;
  #homeFiles: () => Set<string>;
  #durationMs = 0;

  constructor(world: SimWorld, player: SimPlayer, homeFiles: () => Set<string>) {
    this.#world = world;
    this.#player = player;
    this.#homeFiles = homeFiles;
  }

  start(name: string, focus = true): boolean {
    const program = PORT_OPENER_PROGRAMS.find((entry) => entry.name === name);
    if (!program || this.#homeFiles().has(name)) return false;
    const skills = this.#world.person.skills as unknown as Record<string, number>;
    const durationMs = programCreateTimeMs(program, skills["hacking"] ?? 0, skills["intelligence"] ?? 0);
    if (!Number.isFinite(durationMs)) return false;
    this.#durationMs = durationMs;
    this.#player.startWork({
      kind: "createProgram",
      subject: name,
      startedAt: this.#world.clock.now(),
      cyclesWorked: 0,
      unitCycles: 0,
      focused: focus,
    });
    this.#player.focus = focus;
    return true;
  }

  processWork(cycles: number): void {
    const work = this.#player.currentWork;
    if (!work || work.kind !== "createProgram" || this.#durationMs <= 0) return;
    work.cyclesWorked += cycles;
    work.unitCycles = (work.unitCycles ?? 0) + cycles;
    if (work.unitCycles * 200 < this.#durationMs) return;

    this.#homeFiles().add(work.subject);
    this.#world.emit({ kind: "event", name: "program.created", data: { program: work.subject } });
    this.#durationMs = 0;
    this.#player.stopWork();
  }

  prestige(): void {
    this.#durationMs = 0;
  }
}
