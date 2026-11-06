import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadRewindService from "../ThreadRewindService.ts";

/** For harnesses that run the effect worker without exercising rewinds. */
export const layer = Layer.mock(ThreadRewindService.ThreadRewindService)({
  expireUndo: () => Effect.void,
});
