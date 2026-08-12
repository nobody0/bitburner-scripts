import { trainingOption, type TrainingOption } from "../../shared/strategy/career/training.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";

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
    // ClassWork refuses to start when the player cannot pay even its first
    // 200 ms cycle. This also keeps a zero-bankroll caller from repeatedly
    // replacing useful work with a class that immediately terminates.
    if (this.player.money < course.costPerSec / 5) return false;
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

    const costPerCycle = course.costPerSec / 5;
    const payableCycles = Math.min(cycles, Math.floor((this.player.money + 1e-9) / costPerCycle));
    if (payableCycles > 0) {
      const focused = work.focused || this.player.augmentations.has("Neuroreceptor Management Implant");
      const focusBonus = focused ? 1 : 0.8;
      const mults = this.world.person.mults as unknown as Record<string, number>;
      const exp = this.world.person.exp as unknown as Record<string, number>;
      const gained = course.expPerSec * (payableCycles / 5)
        * (mults[`${course.skill}_exp`] ?? 1)
        * currentNodeMults.ClassGymExpGain
        * focusBonus;
      const cost = costPerCycle * payableCycles;
      exp[course.skill] = (exp[course.skill] ?? 0) + gained;
      this.player.money -= cost;
      this.world.recordMoney("other", -cost);
      work.cyclesWorked += payableCycles;
      this.world.recalculateSkills();
    }

    if (payableCycles < cycles) {
      this.player.stopWork();
      this.world.emit({ kind: "event", name: "class.ended", data: { reason: "insufficient money" } });
    }
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
      costPerSec: course.costPerSec * (server?.backdoorInstalled ? 0.9 : 1),
    };
  }
}
