import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { resolveServerBackedAppStageLabel } from "./branding.logic";
import { NAZE_LABS, nazeLabEnabled } from "./nazeLabs";
import { resolveVersionMismatch } from "./versionSkew";

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

describe("naze build versions", () => {
  const build = "0.1.8-nightly.20261107.4301.naze.1";

  it("stay on the nightly stage", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: build,
        fallbackStageLabel: "Latest",
      }),
    ).toBe("Nightly");
    expect(desktopUpdateChannelOf(build)).toBe("nightly");
  });

  it("sort against upstream nightlies by their build number", () => {
    expect(resolveVersionMismatch("0.1.8-nightly.20261107.4301", build)).not.toBeNull();
    expect(resolveVersionMismatch("0.1.8-nightly.20261107.4302", build)).toBeNull();
    expect(resolveVersionMismatch(build, build)).toBeNull();
  });
});
