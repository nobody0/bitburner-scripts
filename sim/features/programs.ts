import { PORT_OPENER_PROGRAMS, programCreateTimeMs } from "../../shared/strategy/career/programs.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";

/** CreateProgramWork for the port-opening programs used by the controller.
 * Work is one-shot, occupies Player.currentWork, survives ordinary controller
 * passes, and only creates the file when the full work unit is banked. */
export class ProgramSystem {
  #world: SimWorld;
  #player: SimPlayer;
  #homeFiles: () => Set<string>;

  constructor(world: SimWorld, player: SimPlayer, homeFiles: () => Set<string>) {
    this.#world = world;
    this.#player = player;
    this.#homeFiles = homeFiles;
  }

  start(name: string, focus = true): boolean {
    const program = PORT_OPENER_PROGRAMS.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (!program || this.#homeFiles().has(program.name)) return false;
    const skills = this.#world.person.skills as unknown as Record<string, number>;
    if (!Number.isFinite(programCreateTimeMs(program, skills["hacking"] ?? 0, skills["intelligence"] ?? 0))) return false;

    let unitCompleted = 0;
    for (const file of this.#homeFiles()) {
      if (!file.startsWith(program.name) || !file.endsWith("%-INC")) continue;
      const pieces = file.split("-");
      if (pieces.length !== 3) break;
      const percent = Number(pieces[1]!.slice(0, -1));
      if (!Number.isFinite(percent) || percent < 0 || percent >= 100) break;
      unitCompleted = (percent / 100) * program.baseTimeMs;
      this.#homeFiles().delete(file);
      break;
    }

    this.#player.startWork({
      kind: "createProgram",
      subject: program.name,
      startedAt: this.#world.clock.now(),
      cyclesWorked: 0,
      unitCompleted,
      focused: focus,
      finish: (cancelled) => this.#finish(program.name, cancelled),
    });
    this.#player.focus = focus;
    return true;
  }

  processWork(cycles: number): void {
    const work = this.#player.currentWork;
    if (!work || work.kind !== "createProgram") return;
    const program = PORT_OPENER_PROGRAMS.find((entry) => entry.name === work.subject);
    if (!program) return;
    const focusBonus = work.focused || this.#player.hasAugmentation("Neuroreceptor Management Implant") ? 1 : 0.8;
    const hacking = this.#world.person.skills.hacking;
    const intelligence = this.#world.person.skills.intelligence;
    const intelligenceBonus = 1 + (3 * Math.pow(intelligence, 0.8)) / 600;
    const skillMult = (hacking / program.level) * intelligenceBonus;
    const unitRate = 200 * (1 + (skillMult - 1) / 5) * focusBonus;
    work.cyclesWorked += cycles;
    work.unitCompleted = (work.unitCompleted ?? 0) + unitRate * cycles;
    if (work.unitCompleted < program.baseTimeMs) return;

    this.#player.stopWork(false);
  }

  /** Restore serialized CreateProgramWork without re-running its constructor
   * (which would consume an incomplete file a second time). */
  restore(name: string, cyclesWorked: number, unitCompleted: number, focus: boolean): boolean {
    const program = PORT_OPENER_PROGRAMS.find((entry) => entry.name === name);
    if (!program) return false;
    this.#player.startWork({
      kind: "createProgram",
      subject: program.name,
      startedAt: this.#world.clock.now() - cyclesWorked * CONSTANTS.MilliPerCycle,
      cyclesWorked,
      unitCompleted,
      focused: focus,
      finish: (cancelled) => this.#finish(program.name, cancelled),
    });
    return true;
  }

  prestige(): void {}

  #finish(name: string, cancelled: boolean): void {
    const work = this.#player.currentWork;
    // Player.currentWork still identifies this work while Work.finish runs.
    if (!cancelled) {
      const cyclesWorked = work?.cyclesWorked ?? 0;
      this.#world.gainIntelligenceExp(
        (CONSTANTS.IntelligenceProgramBaseExpGain * cyclesWorked * 200) / 1_000,
      );
      this.#homeFiles().add(name);
      this.#world.emit({ kind: "event", name: "program.created", data: { program: name } });
      return;
    }
    const completed = work?.unitCompleted ?? 0;
    if (this.#homeFiles().has(name)) return;
    const program = PORT_OPENER_PROGRAMS.find((entry) => entry.name === name);
    if (!program) return;
    const percent = ((100 * completed) / program.baseTimeMs).toFixed(2);
    this.#homeFiles().add(`${name}-${percent}%-INC`);
  }
}
