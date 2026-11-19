import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { add, close, hydration, settingsListeners, settingsState, update } = vi.hoisted(() => ({
  add: vi.fn(() => "slow-requests"),
  close: vi.fn(),
  update: vi.fn(),
  hydration: { loaded: true, finish: () => {} },
  settingsListeners: new Set<() => void>(),
  settingsState: { current: null as ClientSettings | null },
}));

vi.mock("./ui/toast", () => ({ toastManager: { add, close, update } }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => settingsState.current,
  isClientSettingsHydrated: () => hydration.loaded,
  ensureClientSettingsHydrated: () =>
    new Promise<void>((resolve) => {
      hydration.finish = resolve;
    }),
  subscribeClientSettings: (listener: () => void) => {
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  },
}));

import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { startSlowRpcRequestToasts } from "./SlowRpcRequestToastCoordinator";

function setSlowRequestWarnings(enabled: boolean) {
  settingsState.current = { ...DEFAULT_CLIENT_SETTINGS, slowRequestWarningsEnabled: enabled };
  for (const listener of settingsListeners) listener();
}

function makeRequestSlow(requestId: string) {
  trackRpcRequestSent(requestId, "projects.list");
  vi.advanceTimersByTime(15_000);
}

describe("startSlowRpcRequestToasts", () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    settingsListeners.clear();
    settingsState.current = DEFAULT_CLIENT_SETTINGS;
    hydration.loaded = true;
  });

  afterEach(() => {
    stop();
    acknowledgeRpcRequest("request-1");
    acknowledgeRpcRequest("request-2");
    vi.useRealTimers();
  });

  it("warns about slow requests by default", () => {
    stop = startSlowRpcRequestToasts();
    makeRequestSlow("request-1");

    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Some requests are slow" }));
  });

  it("stays quiet while warnings are off", () => {
    setSlowRequestWarnings(false);
    stop = startSlowRpcRequestToasts();
    makeRequestSlow("request-1");
    makeRequestSlow("request-2");

    expect(add).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("waits for saved settings before warning", async () => {
    hydration.loaded = false;
    stop = startSlowRpcRequestToasts();
    makeRequestSlow("request-1");
    expect(add).not.toHaveBeenCalled();

    settingsState.current = { ...DEFAULT_CLIENT_SETTINGS, slowRequestWarningsEnabled: false };
    hydration.finish();
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
  });

  it("warns once saved settings load with warnings on", async () => {
    hydration.loaded = false;
    stop = startSlowRpcRequestToasts();
    makeRequestSlow("request-1");
    expect(add).not.toHaveBeenCalled();

    hydration.finish();
    await Promise.resolve();
    expect(add).toHaveBeenCalledOnce();
  });

  it("closes the open warning when warnings are turned off", () => {
    stop = startSlowRpcRequestToasts();
    makeRequestSlow("request-1");
    setSlowRequestWarnings(false);

    expect(close).toHaveBeenCalledWith("slow-requests");
  });

  it("shows requests that are already slow when warnings are turned back on", () => {
    setSlowRequestWarnings(false);
    stop = startSlowRpcRequestToasts();
    makeRequestSlow("request-1");
    expect(add).not.toHaveBeenCalled();
    setSlowRequestWarnings(true);

    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ description: "1 request waiting longer than 15s." }),
    );
  });
});
