import { expect, test } from "bun:test";
import { RAM_COST_CONSTANTS } from "../../shared/strategy/ram-supply.ts";
import { ServerConstants } from "../vendor/bitburner/src/Server/data/Constants.ts";

test("game-bundle RAM constants match the pinned vendor", () => {
  expect(RAM_COST_CONSTANTS.BaseCostFor1GBOfRamHome).toBe(ServerConstants.BaseCostFor1GBOfRamHome);
  expect(RAM_COST_CONSTANTS.BaseCostFor1GBOfRamServer).toBe(ServerConstants.BaseCostFor1GBOfRamServer);
});
