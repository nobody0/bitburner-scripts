import { trainingOption, type TrainingOption } from "../../shared/strategy/career/training.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";

/** The class/gym slice exercised by the career planner.
 *
 * The planner currently exposes the best Sector-12 options only: Rothman
 * Algorithms/Leadership and Powerhouse's four gym stats. These are upstream
 * v3.0.1's per-second rates and costs. The shared catalog is also used by the
 * game driver; this class applies simulator state and executes the work. */

export class EducationSystem {
  constructor(
    private readonly world: SimWorld,
    private readonly player: SimPlayer,
    private readonly hashLevel: (name: string) => number = () => 0,
  ) {}

  universityCourse(location: string, courseName: string, focus = true): boolean {
    const course = trainingOption("university", courseName);
    if (this.player.city !== "Sector-12" || location !== course?.location || !course) return false;
    return this.start(courseName, this.effective(course), location, focus);
  }

  gymWorkout(location: string, stat: string, focus = true): boolean {
    const course = trainingOption("gym", stat);
    if (this.player.city !== "Sector-12" || location !== course?.location || !course) return false;
    return this.start(course.skill, this.effective(course), location, focus);
  }

  private start(subject: string, course: TrainingOption, location: string, focus: boolean): boolean {
    // Upstream does not perform an affordability check. ClassWork keeps
    // applying its negative money rate even after the balance crosses zero.
    this.player.startWork({
      kind: "class",
      subject,
      workType: course.skill,
      startedAt: this.world.clock.now(),
      cyclesWorked: 0,
      focused: focus,
    });
    this.player.focus = focus;
    this.player.location = location;
    this.world.emit({ kind: "event", name: "class.started", data: { location, subject, skill: course.skill } });
    return true;
  }

  processWork(cycles: number): void {
    const work = this.player.currentWork;
    if (!work || work.kind !== "class") return;
    const baseCourse = this.courseFor(work.subject, work.workType);
    const course = baseCourse && this.effective(baseCourse);
    if (!course) return;

    const mults = this.world.person.mults as unknown as Record<string, number>;
    const exp = this.world.person.exp as unknown as Record<string, number>;
    // Upstream applies ClassGymExpGain to class/gym earnings via
    // `applyWorkStatsExpMult` inside `calculateClassEarnings`. Dropping it made
    // BN4/BN13 training run 2x too fast and disagree with the controller's own
    // forecaster, which does apply it (game/lib/features/career.ts). There is
    // deliberately NO focus penalty here: unlike company/faction work,
    // `ClassWork.process` never calls `focusBonus()` (pinned by
    // sim/tests/career-parity.test.ts).
    const gained = course.expPerSec * (cycles / 5)
      * (mults[`${course.skill}_exp`] ?? 1)
      * currentNodeMults.ClassGymExpGain;
    const cost = course.costPerSec * (cycles / 5);
    exp[course.skill] = (exp[course.skill] ?? 0) + gained;
    this.world.gainIntelligenceExp((course.intelligenceExpPerSec ?? 0) * (cycles / 5));
    this.player.money -= cost;
    this.world.recordMoney("class", -cost);
    work.cyclesWorked += cycles;
    this.world.recalculateSkills();
  }

  private courseFor(subject: string, skill?: string): TrainingOption | undefined {
    return trainingOption("university", subject) ?? (skill ? trainingOption("gym", skill) : undefined);
  }

  private effective(course: TrainingOption): TrainingOption {
    const gym = course.kind === "gym";
    const expMult = 1 + 0.2 * this.hashLevel(gym ? "Improve Gym Training" : "Improve Studying");
    const server = this.world.servers.get(gym ? "powerhouse-fitness" : "rothman-uni");
    return {
      ...course,
      expPerSec: course.expPerSec * expMult,
      intelligenceExpPerSec: (course.intelligenceExpPerSec ?? 0) * expMult,
      costPerSec: course.costPerSec * (server?.backdoorInstalled ? 0.9 : 1),
    };
  }
}
