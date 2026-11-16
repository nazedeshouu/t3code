import type { ReactNode } from "react";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerSurface } from "./ComposerSurface";

const THEME_COLOR = "rgb(10, 20, 30)";
const THEME_IMAGE = "linear-gradient(90deg, rgb(1, 2, 3), rgb(4, 5, 6))";

/** The fill of every element that draws the card right now. */
function drawnCardFills(container: HTMLElement) {
  const shell = container.querySelector<HTMLElement>('[data-slot="composer-shell"]')!;
  const host = container.querySelector<HTMLElement>('[data-slot="composer-host"]')!;
  const main = container.querySelector<HTMLElement>("[data-chat-composer-main-surface]")!;
  const candidates = [
    getComputedStyle(shell, "::before"),
    getComputedStyle(host, "::before"),
    getComputedStyle(main),
  ];
  return candidates
    .filter(
      (style) =>
        style.display !== "none" && style.content !== "none" && style.backdropFilter !== "none",
    )
    .map((style) => ({ color: style.backgroundColor, image: style.backgroundImage }));
}

function Composer({ contextRow = false, banner }: { contextRow?: boolean; banner?: ReactNode }) {
  return (
    <ComposerSurface.Shell contextRow={contextRow}>
      <ComposerSurface.Host>
        <ComposerBanner.Dock>{banner}</ComposerBanner.Dock>
        <ComposerSurface.Main>Prompt</ComposerSurface.Main>
      </ComposerSurface.Host>
      {contextRow ? <ComposerSurface.ContextStrip>main</ComposerSurface.ContextStrip> : null}
    </ComposerSurface.Shell>
  );
}

const attachedBanner = (
  <ComposerBanner.Attachment>
    <ComposerBanner.Root>Replying to</ComposerBanner.Root>
  </ComposerBanner.Attachment>
);

// A banner or a context row moves the card's fill to another element. A theme styles the card
// once, so whichever element draws it has to take the theme's fill.
it.each([
  { state: "alone", composer: <Composer /> },
  { state: "with a context row", composer: <Composer contextRow /> },
  { state: "with a banner attached", composer: <Composer banner={attachedBanner} /> },
  {
    state: "with a banner and a context row",
    composer: <Composer contextRow banner={attachedBanner} />,
  },
])("the composer card $state has one fill, and it is the theme's", async ({ composer }) => {
  await using screen = await render(
    <div
      style={
        {
          "--composer-card-color": THEME_COLOR,
          "--composer-card-image": THEME_IMAGE,
        } as React.CSSProperties
      }
    >
      {composer}
    </div>,
  );

  expect(drawnCardFills(screen.container)).toEqual([{ color: THEME_COLOR, image: THEME_IMAGE }]);
});

it("the composer card keeps its own glass fill when a theme sets none", async () => {
  await using screen = await render(<Composer banner={attachedBanner} />);

  const [fill] = drawnCardFills(screen.container);
  expect(fill?.image).toBe("none");
  expect(fill?.color).not.toBe("rgba(0, 0, 0, 0)");
});
