(() => {
  const gsap = window.gsap;
  const captionData = window.__captionData;
  if (!gsap || !captionData) {
    throw new Error("Local GSAP and caption data must load before animation.js.");
  }

  const stage = document.querySelector("[data-composition-id]");
  const COMP = stage.dataset.compositionId;
  const HEIGHT = parseFloat(stage.dataset.height);
  const WIDTH = parseFloat(stage.dataset.width);
  const TOTAL = parseFloat(stage.dataset.duration);

  const at = (id) => parseFloat(document.querySelector(id).dataset.start);
  const len = (id) => parseFloat(document.querySelector(id).dataset.duration);

  const timeline = gsap.timeline({paused: true});

  /* ── captions ─────────────────────────────────────────────────────────── */

  const captionLayer = document.querySelector("#caption-layer");
  const pagesByCue = new Map();

  for (const page of captionData.pages) {
    const paragraph = document.createElement("p");
    paragraph.className = "caption-page";
    paragraph.dataset.cueIndex = String(page.cueIndex);
    paragraph.dataset.fromMs = String(page.fromMs);
    paragraph.dataset.toMs = String(page.toMs);
    paragraph.setAttribute("aria-label", page.text);

    const words = captionData.tokens.filter((token) => token.cueIndex === page.cueIndex);
    for (const token of words) {
      const span = document.createElement("span");
      span.className = "word";
      span.textContent = token.text;
      span.dataset.fromMs = String(token.fromMs);
      span.dataset.toMs = String(token.toMs);
      span.dataset.cueIndex = String(token.cueIndex);
      paragraph.appendChild(span);
    }

    captionLayer.appendChild(paragraph);
    pagesByCue.set(page.cueIndex, paragraph);
  }

  /* ── scene bookkeeping ────────────────────────────────────────────────── */

  const SCENES = [
    "#scene-cheap-consistency",
    "#scene-industry-mistake",
    "#scene-deadline-receipt",
    "#scene-editorial-turn",
    "#scene-payoff",
    "#scene-brand-outro",
  ];

  const S1 = at(SCENES[0]);
  const S2 = at(SCENES[1]);
  const S3 = at(SCENES[2]);
  const S4 = at(SCENES[3]);
  const S5 = at(SCENES[4]);
  const S6 = at(SCENES[5]);

  timeline.set(SCENES, {autoAlpha: 0});
  timeline.set(".caption-page", {autoAlpha: 0, y: 15});

  SCENES.forEach((id, index) => {
    timeline.set(id, {autoAlpha: 1}, at(id));
    if (index < SCENES.length - 1) {
      timeline.set(id, {autoAlpha: 0}, at(SCENES[index + 1]));
    }
  });

  /* ── the continuous accent: one step per scene, then it holds ─────────── */

  // Every initial state is pinned to 0. A positionless set() is appended at the
  // timeline's current end, which lands it after the beats it is meant to precede.
  timeline.set(".spine-line", {scaleY: 0, transformOrigin: "top center"}, 0);
  timeline.set(".spine-node", {y: 0}, 0);

  SCENES.forEach((id) => {
    const progress = (at(id) + len(id)) / TOTAL;
    timeline.to(".spine-line", {
      scaleY: progress, transformOrigin: "top center", duration: 0.5, ease: "power2.inOut",
    }, at(id) + 0.06);
    timeline.to(".spine-node", {
      y: HEIGHT * progress, duration: 0.5, ease: "power2.inOut",
    }, at(id) + 0.06);
  });

  // The thread inverts over the yellow field so it stays legible, then returns.
  timeline.set(".spine-line, .spine-node", {backgroundColor: "var(--brand-purple)"}, S5);
  timeline.set(".spine-line, .spine-node", {backgroundColor: "var(--brand-yellow)"}, S6);

  /* ── 1 · cheap-consistency — type low-left, a stack of sheets off the right ── */

  timeline.set("#scene-cheap-consistency .sheet", {autoAlpha: 0}, 0);
  timeline.set(".cheap-slab", {scaleX: 0, transformOrigin: "left center"}, 0);
  timeline.set(".mark-tag", {autoAlpha: 0}, 0);

  timeline.fromTo("#scene-cheap-consistency .kicker",
    {autoAlpha: 0, x: -44},
    {autoAlpha: 1, x: 0, duration: 0.374, ease: "power3.out"}, S1 + 0.06);
  timeline.fromTo(".scene-cheap h1 .line-a",
    {autoAlpha: 0, y: 84},
    {autoAlpha: 1, y: 0, duration: 0.374, ease: "power3.out"}, S1 + 0.2);
  timeline.fromTo(".scene-cheap h1 .line-b",
    {autoAlpha: 0, y: 84},
    {autoAlpha: 1, y: 0, duration: 0.374, ease: "power3.out"}, S1 + 0.3);
  timeline.fromTo("#scene-cheap-consistency .rule",
    {autoAlpha: 0, x: -30},
    {autoAlpha: 1, x: 0, duration: 0.374, ease: "power3.out"}, S1 + 0.62);

  // The one earned yellow: it lands under "is cheap" and stays put.
  timeline.to(".cheap-slab", {
    scaleX: 1, transformOrigin: "left center", duration: 0.48, ease: "power3.out",
  }, S1 + 0.78);

  // Beat: the same post, filed again and again, arriving one after another.
  timeline.fromTo("#scene-cheap-consistency .sheet",
    {autoAlpha: 0, y: WIDTH * 0.11, x: WIDTH * 0.06},
    {autoAlpha: 1, y: 0, x: 0, duration: 0.42, stagger: 0.3, ease: "power3.out"}, S1 + 1.35);

  // Beat: the stack collapses into one identical shape.
  // They converge on the middle sheet, so the resolved pile sits in the body rather
  // than riding the top edge with a void beneath it.
  timeline.to("#scene-cheap-consistency .sheet", {
    yPercent: (index) => (2 - index) * 47.06,
    duration: 0.62,
    ease: "power2.inOut",
  }, S1 + 3.95);
  timeline.to("#scene-cheap-consistency .sheet:not(.sheet-lead) .sheet-lines", {
    autoAlpha: 0.3, duration: 0.5, ease: "power2.out",
  }, S1 + 3.95);

  timeline.fromTo(".mark-tag",
    {autoAlpha: 0, scale: 0.84, transformOrigin: "left center"},
    {autoAlpha: 1, scale: 1, duration: 0.32, ease: "power3.out"}, S1 + 5.0);

  /* ── 2 · industry-mistake — inverse field, three bands, headline at the foot ── */

  timeline.set("#scene-industry-mistake .cal-row", {autoAlpha: 0}, 0);
  timeline.set(".cal-slab i", {scaleX: 0, transformOrigin: "left center"}, 0);
  timeline.set(".cal-chip", {autoAlpha: 0}, 0);
  timeline.set(".cal-verdict", {autoAlpha: 0, scaleX: 0, transformOrigin: "right bottom"}, 0);

  timeline.fromTo("#scene-industry-mistake .field-purple",
    {scaleY: 0, transformOrigin: "top center"},
    {scaleY: 1, duration: 0.18, ease: "power1.out"}, S2);
  timeline.fromTo("#scene-industry-mistake .kicker, #scene-industry-mistake .section-number",
    {autoAlpha: 0, x: -26},
    {autoAlpha: 1, x: 0, duration: 0.22, stagger: 0.025, ease: "power1.out"}, S2 + 0.1);

  // Edge energy: the rows cut in flat, no glide.
  timeline.fromTo("#scene-industry-mistake .cal-row",
    {autoAlpha: 0, x: WIDTH * 0.42},
    {autoAlpha: 1, x: 0, duration: 0.247, stagger: 0.13, ease: "power1.out"}, S2 + 0.22);
  timeline.to(".cal-slab i", {
    scaleX: 1, transformOrigin: "left center", duration: 0.3, stagger: 0.06, ease: "power1.out",
  }, S2 + 0.95);

  timeline.fromTo(".cal-title span",
    {autoAlpha: 0, y: 62},
    {autoAlpha: 1, y: 0, duration: 0.247, stagger: 0.025, ease: "power2.out"}, S2 + 1.55);
  timeline.to(".cal-chip", {
    autoAlpha: 1, duration: 0.22, stagger: 0.12, ease: "power1.out",
  }, S2 + 2.55);

  // Beat: three published slots, and every one of them empties.
  timeline.to(".cal-slab i", {autoAlpha: 0, duration: 0.3, ease: "power2.in"}, S2 + 4.85);
  // The slot does not vanish, it hollows out: three filled bands become three empty
  // outlines, which is the point and a large-area change at the same time.
  timeline.to(".cal-slab", {
    backgroundColor: "rgba(255,255,255,0)", duration: 0.6, ease: "power2.inOut",
  }, S2 + 5.2);
  timeline.to(".cal-chip", {
    backgroundColor: "rgba(255,255,255,0)", borderColor: "var(--brand-light-purple)",
    color: "var(--brand-light-purple)", duration: 0.3, ease: "power1.out",
  }, S2 + 5.95);
  timeline.to(".cal-verdict", {
    autoAlpha: 1, scaleX: 1, transformOrigin: "right bottom", duration: 0.4, ease: "power2.out",
  }, S2 + 6.5);

  /* ── 3 · deadline-receipt — evidence left, gauge card on the right edge ─── */

  timeline.set(".receipt-card", {scaleY: 0, transformOrigin: "bottom center"}, 0);
  timeline.set(".card-head, .gauge, .gauge-foot", {autoAlpha: 0}, 0);
  timeline.set(".gauge-empty", {autoAlpha: 0}, 0);
  timeline.set(".gauge-cap b", {autoAlpha: 0}, 0);
  timeline.set(".gauge-bar > span", {scaleY: 0, transformOrigin: "bottom center"}, 0);
  timeline.set(".receipt-note", {autoAlpha: 0, clipPath: "inset(0 100% 0 0)"}, 0);
  timeline.set(".deadline-band", {autoAlpha: 0}, 0);
  timeline.set(".receipt-rule", {scaleX: 0, transformOrigin: "left center"}, 0);
  timeline.set(".scene-receipt .data-source", {autoAlpha: 0}, 0);
  timeline.set(".receipt-head .data-figure", {textContent: "0"}, S3);

  // Beat: the evidence card rises out of the paper.
  timeline.to(".receipt-card", {
    scaleY: 1, transformOrigin: "bottom center", duration: 0.62, ease: "power3.out",
  }, S3 + 0.07);
  timeline.fromTo("#scene-deadline-receipt .kicker",
    {autoAlpha: 0, x: -40},
    {autoAlpha: 1, x: 0, duration: 0.505, ease: "power3.out"}, S3 + 0.3);
  timeline.fromTo(".receipt-head",
    {autoAlpha: 0, y: 56},
    {autoAlpha: 1, y: 0, duration: 0.505, ease: "power3.out"}, S3 + 0.55);
  timeline.to(".card-head, .gauge, .gauge-foot", {
    autoAlpha: 1, duration: 0.4, stagger: 0.052, ease: "power2.out",
  }, S3 + 0.8);

  // Beat: the figure counts and the column fills to its declared 25%, together.
  const counter = {value: 0};
  const figureEl = document.querySelector(".receipt-head .data-figure");
  timeline.to(counter, {
    value: 25,
    duration: 2.35,
    ease: "power1.out",
    onUpdate: () => { figureEl.textContent = String(Math.round(counter.value)); },
  }, S3 + 1.16);
  timeline.to(".gauge-bar > span", {
    scaleY: 0.25, transformOrigin: "bottom center", duration: 2.35, ease: "power1.out",
  }, S3 + 1.16);
  timeline.fromTo(".gauge-cap",
    {bottom: "0%"},
    {bottom: "25%", duration: 2.35, ease: "power1.out"}, S3 + 1.16);
  timeline.to(".gauge-cap b", {autoAlpha: 1, duration: 0.34, ease: "power2.out"}, S3 + 3.6);

  // Beat: the claim is stated narrowly, then bounded to its condition.
  timeline.to(".receipt-note", {
    autoAlpha: 1, clipPath: "inset(0 0% 0 0)", duration: 0.7, ease: "power2.out",
  }, S3 + 4.1);
  timeline.to(".gauge-empty", {autoAlpha: 1, duration: 0.6, ease: "power2.out"}, S3 + 5.35);
  timeline.fromTo(".deadline-band",
    {autoAlpha: 0, x: -WIDTH * 0.18},
    {autoAlpha: 1, x: 0, duration: 0.55, ease: "power3.out"}, S3 + 6.65);
  timeline.to(".receipt-rule", {
    scaleX: 1, transformOrigin: "left center", duration: 0.5, ease: "power2.out",
  }, S3 + 8.05);
  timeline.to(".scene-receipt .data-source", {
    autoAlpha: 1, duration: 0.5, ease: "power2.out",
  }, S3 + 8.2);

  /* ── 4 · editorial-turn — a held card, the shortcut passing behind it ───── */

  timeline.set(".turn-card, .turn-panel", {autoAlpha: 0}, 0);
  timeline.set(".turn-rail", {scaleY: 0, transformOrigin: "top center"}, 0);
  timeline.set(".turn-band", {clipPath: "inset(100% 0 0 0)"}, 0);
  timeline.set("#scene-editorial-turn .rule", {autoAlpha: 0}, 0);

  timeline.fromTo("#scene-editorial-turn .field-tint",
    {autoAlpha: 0},
    {autoAlpha: 1, duration: 0.3, ease: "power2.out"}, S4 + 0.05);
  timeline.fromTo("#scene-editorial-turn .lane",
    {autoAlpha: 0, x: -WIDTH * 0.7},
    {autoAlpha: 1, x: 0, duration: 0.42, stagger: 0.12, ease: "power3.out"}, S4 + 0.1);
  timeline.fromTo("#scene-editorial-turn .kicker",
    {autoAlpha: 0, y: 30},
    {autoAlpha: 1, y: 0, duration: 0.299, ease: "power3.out"}, S4 + 0.3);

  // Lift energy: everything travels upward into place.
  timeline.fromTo(".turn-card",
    {autoAlpha: 0, y: 96},
    {autoAlpha: 1, y: 0, duration: 0.34, ease: "power3.out"}, S4 + 0.7);
  timeline.fromTo(".turn-label, .scene-turn h1 span",
    {autoAlpha: 0, y: 52},
    {autoAlpha: 1, y: 0, duration: 0.299, stagger: 0.031, ease: "power3.out"}, S4 + 0.85);
  timeline.to(".turn-rail", {
    scaleY: 1, transformOrigin: "top center", duration: 0.5, ease: "power3.out",
  }, S4 + 1.45);
  timeline.to("#scene-editorial-turn .rule", {
    autoAlpha: 1, duration: 0.36, ease: "power2.out",
  }, S4 + 1.8);

  // Beat: the two pale lanes sweep past and leave. The card does not move, and the
  // one yellow lane squares up and stays — the judgment the shortcut did not carry off.
  timeline.to("#scene-editorial-turn .lane-a, #scene-editorial-turn .lane-c", {
    x: WIDTH * 0.9, autoAlpha: 0, duration: 0.8, stagger: 0.08, ease: "power2.in",
  }, S4 + 3.76);
  timeline.to("#scene-editorial-turn .lane-b", {
    rotation: 0, duration: 0.8, ease: "power2.inOut",
  }, S4 + 3.9);

  // Beat: what the card keeps.
  timeline.to(".turn-band", {
    clipPath: "inset(0% 0 0 0)", duration: 0.5, ease: "power2.out",
  }, S4 + 5.56);
  timeline.fromTo(".turn-panel",
    {autoAlpha: 0, y: 64},
    {autoAlpha: 1, y: 0, duration: 0.45, ease: "power3.out"}, S4 + 6.6);

  /* ── 5 · payoff — yellow field, type right, a two-row ledger below ──────── */

  timeline.set(".payoff-panel", {autoAlpha: 0}, 0);
  timeline.set(".payoff-rule", {scaleX: 0, transformOrigin: "right center"}, 0);
  timeline.set(".p-row .row-key, .p-row .row-name", {autoAlpha: 0}, 0);
  timeline.set(".row-template .row-fill", {scaleX: 0, transformOrigin: "left center"}, 0);
  timeline.set(".row-judgment .row-fill", {scaleX: 0, transformOrigin: "left center"}, 0);

  timeline.fromTo("#scene-payoff .field-yellow",
    {scaleY: 0, transformOrigin: "bottom center"},
    {scaleY: 1, duration: 0.38, ease: "power3.out"}, S5 + 0.05);
  timeline.fromTo("#scene-payoff .kicker",
    {autoAlpha: 0, y: 26},
    {autoAlpha: 1, y: 0, duration: 0.299, ease: "power3.out"}, S5 + 0.3);
  timeline.fromTo(".payoff-title span",
    {autoAlpha: 0, y: 74},
    {autoAlpha: 1, y: 0, duration: 0.299, stagger: 0.031, ease: "power3.out"}, S5 + 0.42);
  timeline.to(".payoff-rule", {
    scaleX: 1, transformOrigin: "right center", duration: 0.4, ease: "power3.out",
  }, S5 + 0.8);

  timeline.fromTo(".payoff-panel",
    {autoAlpha: 0, y: 118},
    {autoAlpha: 1, y: 0, duration: 0.5, ease: "power3.out"}, S5 + 1.25);
  timeline.to(".row-template .row-fill", {
    scaleX: 1, transformOrigin: "left center", duration: 0.45, ease: "power2.out",
  }, S5 + 1.98);
  timeline.to(".p-row .row-key, .p-row .row-name", {
    autoAlpha: 1, duration: 0.3, stagger: 0.031, ease: "power2.out",
  }, S5 + 2.38);

  // Beat: the second row is the one that gets marked.
  timeline.to(".row-judgment .row-fill", {
    scaleX: 1, transformOrigin: "left center", duration: 0.6, ease: "power3.out",
  }, S5 + 5.03);
  timeline.set(".row-judgment .row-key, .row-judgment .row-name",
    {color: "var(--brand-purple)"}, S5 + 5.33);

  // Beat: and the template stops being the answer.
  timeline.to(".row-template .row-fill", {
    scaleX: 0, transformOrigin: "right center", duration: 0.5, ease: "power2.inOut",
  }, S5 + 6.53);
  timeline.to(".row-template .row-key, .row-template .row-name", {
    color: "var(--brand-light-purple)", duration: 0.5, ease: "power2.inOut",
  }, S5 + 6.53);

  /* ── 6 · brand-outro — the identity card, silent ────────────────────────── */

  timeline.set(".outro-lockup, .outro-context, .scene-outro .cta-url", {autoAlpha: 0}, 0);
  timeline.set(".outro-topline", {scaleX: 0, transformOrigin: "left center"}, 0);
  timeline.set(".outro-rule", {scaleX: 0, transformOrigin: "left center"}, 0);
  timeline.set(".outro-base", {scaleY: 0, transformOrigin: "bottom center"}, 0);

  timeline.to("#brand-rail", {autoAlpha: 0, duration: 0.16, ease: "power2.in"}, S6 - 0.14);

  timeline.fromTo("#scene-brand-outro .field-paper",
    {scaleY: 0, transformOrigin: "top center"},
    {scaleY: 1, duration: 0.34, ease: "power3.out"}, S6 + 0.05);
  timeline.to(".outro-topline", {
    scaleX: 1, transformOrigin: "left center", duration: 0.36, ease: "power3.out",
  }, S6 + 0.2);
  timeline.fromTo(".outro-lockup",
    {autoAlpha: 0, y: 46},
    {autoAlpha: 1, y: 0, duration: 0.34, ease: "power3.out"}, S6 + 0.38);
  timeline.to(".outro-rule", {
    scaleX: 1, transformOrigin: "left center", duration: 0.34, ease: "power3.out",
  }, S6 + 0.64);

  // Beat: the deep plate rises under the mark and the frame resolves into one card.
  timeline.to(".outro-base", {
    scaleY: 1, transformOrigin: "bottom center", duration: 0.46, ease: "power3.out",
  }, S6 + 0.84);
  timeline.fromTo(".outro-context",
    {autoAlpha: 0, y: 38},
    {autoAlpha: 1, y: 0, duration: 0.32, ease: "power3.out"}, S6 + 1.12);
  timeline.fromTo(".scene-outro .cta-url",
    {autoAlpha: 0, y: 24},
    {autoAlpha: 1, y: 0, duration: 0.3, ease: "power3.out"}, S6 + 1.4);

  /* ── caption pages ─────────────────────────────────────────────────────── */

  captionData.pages.forEach((page, pageIndex) => {
    const element = pagesByCue.get(page.cueIndex);
    const nextPage = captionData.pages[pageIndex + 1];
    // Measured cues can overlap by a fraction of a second; a page always leaves
    // before the next one arrives so two scrims never stack.
    const outMs = nextPage ? Math.min(page.toMs, nextPage.fromMs) : page.toMs;
    const pageWords = [...element.querySelectorAll(".word")];
    const pageTokens = captionData.tokens.filter((item) => item.cueIndex === page.cueIndex);

    timeline.fromTo(element,
      {autoAlpha: 0, y: 15},
      {autoAlpha: 1, y: 0, duration: 0.15, ease: "power2.out"},
      page.fromMs / 1000);

    pageTokens.forEach((token, index) => {
      if (token.fromMs >= outMs) return;
      timeline.set(pageWords, {
        color: (wordIndex) => (wordIndex === index ? "var(--brand-yellow)" : "var(--brand-paper)"),
      }, token.fromMs / 1000);
    });

    timeline.set(element, {autoAlpha: 0, y: -8}, outMs / 1000);
  });

  // Hold the resolved outro card to the last frame.
  timeline.set(".signal-spine", {autoAlpha: 1}, TOTAL);

  window.__timelines = window.__timelines || {};
  window.__timelines[COMP] = timeline;
})();
