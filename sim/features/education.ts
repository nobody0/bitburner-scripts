import { trainingOption, type TrainingOption } from "../../shared/strategy/career/training.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { hashUpgradeMult } from "./hacknet.ts";

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
    // ClassGymExpGain is deliberately NOT applied. The multiplier exists in
    // BitNodeMultipliers and the BN4/BN12/BN13 definitions, but v3.0.1 has no
    // consumer for it: `calculateClassEarnings` (src/Work/Formulas.ts:108-121)
    // applies only the location's expMult/gameCPS, the hash multiplier and
    // `person.mults`. Applying it here ran BN4/BN13 training at half the game's
    // rate — and because the controller's forecaster made the same assumption,
    // the two agreed with each other and disagreed with the game.
    // There is also NO focus penalty: unlike company/faction work,
    // `ClassWork.process` never calls `focusBonus()` (pinned by
    // sim/tests/career-parity.test.ts).
    const gained = course.expPerSec * (cycles / 5) * (mults[`${course.skill}_exp`] ?? 1);
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
    const expMult = hashUpgradeMult(this.hashLevel(gym ? "Improve Gym Training" : "Improve Studying"));
    const server = this.world.servers.get(gym ? "powerhouse-fitness" : "rothman-uni");
    return {
      ...course,
      expPerSec: course.expPerSec * expMult,
      intelligenceExpPerSec: (course.intelligenceExpPerSec ?? 0) * expMult,
      costPerSec: course.costPerSec * (server?.backdoorInstalled ? 0.9 : 1),
    };
  }
}
