/**
 * Everything injected into a page before a screenshot is taken.
 *
 * Two jobs: make the capture deterministic (no animation mid-flight, no blinking
 * caret, no lazy fade still running), and remove the furniture that only exists
 * because the app is running in development. A Next.js dev build paints its own
 * badge over the corner of every page, and that badge has no business appearing in
 * a brand video.
 */
export const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-delay: -1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }

  /* Anything still mid-reveal would capture half-faded. */
  [data-animate], [class*="fade"], [class*="reveal"], [class*="animate"] {
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
  }

  html { scrollbar-width: none; }
  ::-webkit-scrollbar { display: none !important; }
`;

/**
 * Development overlays. Selectors are deliberately broad because these badges move
 * between framework versions, and a stray dev logo in a finished video is worse than
 * an over-eager hide rule.
 */
export const HIDE_DEV_OVERLAYS_CSS = `
  /* Next.js dev indicator and error overlay, across versions. */
  nextjs-portal,
  #__next-build-watcher,
  #__next-prerender-indicator,
  [data-nextjs-toast],
  [data-nextjs-dialog-overlay],
  [data-nextjs-build-indicator],
  .nextjs-toast,
  .__next-dev-overlay,

  /* Vite, Nuxt, Astro, Turbopack and friends. */
  vite-error-overlay,
  vite-plugin-checker-error-overlay,
  #nuxt-devtools-container,
  astro-dev-toolbar,
  #turbopack-dev-overlay,

  /* Common third-party widgets that have no place in a brand asset. */
  #vercel-live-feedback,
  [data-vercel-toolbar],
  [id^="crisp-chatbox"],
  .intercom-lightweight-app,
  #hubspot-messages-iframe-container {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
`;

/** Shadow-DOM badges ignore stylesheets, so remove the hosts outright. */
export const REMOVE_DEV_OVERLAYS_JS = `
  (() => {
    const selectors = [
      "nextjs-portal",
      "#__next-build-watcher",
      "[data-nextjs-build-indicator]",
      "vite-error-overlay",
      "astro-dev-toolbar",
      "#nuxt-devtools-container",
      "[data-vercel-toolbar]",
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) node.remove();
    }
  })();
`;
