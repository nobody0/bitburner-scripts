import { expect, test } from "bun:test";
import { waitForRfaConnection } from "../tools/rfa-connect.ts";

test("an unanswered Remote API listener times out instead of becoming stale", async () => {
  await expect(waitForRfaConnection({ host: "127.0.0.1", port: 0 }, 20)).rejects.toThrow("timed out after 20ms");
});
