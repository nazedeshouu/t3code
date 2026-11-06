import * as Cause from "effect/Cause";
import { expect, it } from "vite-plus/test";

import { isUnknownRequestCause } from "./query";

it("recognizes the server's answer to a request it has no handler for", () => {
  expect(isUnknownRequestCause(Cause.die("Unknown request tag: orchestration.previewRewind"))).toBe(
    true,
  );
  expect(isUnknownRequestCause(Cause.die("boom"))).toBe(false);
  expect(isUnknownRequestCause(Cause.fail(new Error("Unknown request tag: nope")))).toBe(false);
});
