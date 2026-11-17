import type { CSSProperties, ReactNode } from "react";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerSurface } from "./ComposerSurface";

const THEME_COLOR = "rgb(10, 20, 30)";
const THEME_IMAGE = "linear-gradient(90deg, rgb(1, 2, 3), rgb(4, 5, 6))";

// The card with no theme: the shell's surface colour at the glass opacity, blurred.
const APP_GLASS: CSSProperties = {
  backgroundColor:
    "color-mix(in oklab, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)",
  backdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturation))",
};

const fillOf = (style: CSSStyleDeclaration) => ({
  color: style.backgroundColor,
  image: style.backgroundImage,
  filter: style.backdropFilter,
});

/** The fill of every element that draws the card right now, beside the app's own glass. */
function cardFills(container: HTMLElement) {
  const find = (selector: string) => container.querySelector<HTMLElement>(selector)!;
  const drawn = [
    getComputedStyle(find('[data-slot="composer-shell"]'), "::before"),
    getComputedStyle(find('[data-slot="composer-host"]'), "::before"),
    getComputedStyle(find("[data-chat-composer-main-surface]")),
  ]
    .filter(
      (style) =>
        style.display !== "none" &&
        style.content !== "none" &&
        (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none"),
    )
    .map(fillOf);
  return { drawn, appGlass: fillOf(getComputedStyle(find("[data-app-glass]"))) };
}

function Composer({ contextRow = false, banner }: { contextRow?: boolean; banner?: ReactNode }) {
  return (
    <ComposerSurface.Shell contextRow={contextRow}>
      <ComposerSurface.Host>
        <ComposerBanner.Dock>{banner}</ComposerBanner.Dock>
        <ComposerSurface.Main>
          Prompt
          <i data-app-glass style={APP_GLASS} />
        </ComposerSurface.Main>
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

// A banner or a context row moves the card's fill to another element.
const STATES = [
  { state: "alone", composer: <Composer /> },
  { state: "with a context row", composer: <Composer contextRow /> },
  { state: "with a banner attached", composer: <Composer banner={attachedBanner} /> },
  {
    state: "with a banner and a context row",
    composer: <Composer contextRow banner={attachedBanner} />,
  },
];

// A theme styles the card once, so whichever element draws it has to take the theme's fill.
it.each(STATES)("the composer card $state has one fill, the theme's", async ({ composer }) => {
  await using screen = await render(
    <div
      style={
        {
          "--composer-card-color": THEME_COLOR,
          "--composer-card-image": THEME_IMAGE,
        } as CSSProperties
      }
    >
      {composer}
    </div>,
  );

  const { drawn, appGlass } = cardFills(screen.container);
  expect(drawn).toEqual([{ color: THEME_COLOR, image: THEME_IMAGE, filter: appGlass.filter }]);
});

it.each(STATES)(
  "the composer card $state has the app's glass without a theme",
  async ({ composer }) => {
    await using screen = await render(composer);

    const { drawn, appGlass } = cardFills(screen.container);
    expect(appGlass.filter).not.toBe("none");
    expect(drawn).toEqual([appGlass]);
  },
);
