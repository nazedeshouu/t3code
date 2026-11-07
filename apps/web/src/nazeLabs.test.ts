import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { NAZE_LABS, nazeLabEnabled } from "./nazeLabs";

const decode = Schema.decodeUnknownSync(ClientSettingsSchema);

describe("nazeLabEnabled", () => {
  it("is on for every lab until a stored value turns it off", () => {
    for (const { id } of NAZE_LABS) {
      expect(nazeLabEnabled(DEFAULT_CLIENT_SETTINGS, id)).toBe(true);
      expect(nazeLabEnabled({ nazeLabs: { [id]: false } }, id)).toBe(false);
    }
  });

  it("keeps a stored choice, and reads settings saved before labs existed as on", () => {
    expect(nazeLabEnabled(decode({ nazeLabs: { "naze-rewind": false } }), "naze-rewind")).toBe(
      false,
    );
    expect(nazeLabEnabled(decode({}), "naze-tool-file-links")).toBe(true);
  });
});
