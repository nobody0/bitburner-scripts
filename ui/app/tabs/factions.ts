import { card, note, table, tiles } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Factions tab: reputation standing, pending invites, and the augmentation
 * shopping list (grafting included — it is another way to buy the same augs). */

export const factionsTab: Tab = {
  id: "factions",
  render(state: ProjectedState) {
    const f = state.topics.factions;
    if (!f) return note("waiting for the factions probe");

    const summary = tiles([
      { label: "joined", value: String(f.joined.length) },
      { label: "invites", value: f.invites ? String(f.invites.length) : "–" },
      { label: "augs owned", value: f.ownedAugs ? String(f.ownedAugs.length) : "–" },
      { label: "augs available", value: f.augTotal !== undefined ? String(f.augTotal) : "–" },
    ]);

    const standings = f.standings
      ? table(
          ["faction", "rep", "favor", "donate at"],
          f.standings
            .slice()
            .sort((a, b) => b.rep - a.rep)
            .map((s) => [
              esc(s.name),
              fmtNum(s.rep, 0),
              `<span class="${s.favorToDonate !== undefined && s.favor >= s.favorToDonate ? "good" : ""}">${fmtNum(s.favor, 1)}</span>`,
              s.favorToDonate !== undefined ? fmtNum(s.favorToDonate, 0) : "–",
            ]),
        )
      : table(
          ["faction"],
          f.joined.map((name) => [esc(name)]),
          "no factions joined",
        ) + note("rep and favor need BN4 or SF4 (Singularity)");

    const invites =
      f.invites && f.invites.length > 0
        ? table(
            ["faction", "requirements"],
            f.invites.map((name) => [esc(name), esc((f.inviteRequirements?.[name] ?? []).join(", ").slice(0, 200))]),
          )
        : note("no pending invitations");

    const offers = f.offers
      ? table(
          ["augmentation", "faction", "price", "rep req", "rep?"],
          f.offers
            .slice(0, 60)
            .map((a) => [
              esc(a.name),
              esc(a.faction),
              fmtMoney(a.price),
              fmtNum(a.repReq, 0),
              `<span class="${a.affordableRep ? "good" : "muted"}">${a.affordableRep ? "yes" : "no"}</span>`,
            ]),
          "nothing purchasable",
        ) +
        (f.augTotal !== undefined && f.augTotal > (f.offers?.length ?? 0)
          ? note(`showing ${f.offers.length} of ${f.augTotal} — the probe caps its list`)
          : "")
      : note("augmentation list needs BN4 or SF4");

    const graft =
      f.graftable && f.graftable.length > 0
        ? table(
            ["augmentation", "price", "time"],
            f.graftable.slice(0, 40).map((g) => [esc(g.name), fmtMoney(g.price), fmtTime(g.timeMs)]),
          )
        : note("nothing graftable (needs New Tokyo's VitaLife clinic)");

    return (
      `<div class="col wide">` +
      card("Standing", summary + standings) +
      card("Augmentations", offers) +
      `</div>` +
      `<div class="col">` +
      card("Invitations", invites) +
      card("Grafting", graft) +
      `</div>`
    );
  },
};
