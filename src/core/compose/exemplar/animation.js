(() => {
  const gsap = window.gsap;
  const captionData = window.__captionData;
  if (!gsap || !captionData) {
    throw new Error("Local GSAP and caption data must load before animation.js.");
  }

  const timeline = gsap.timeline({paused: true});
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

  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => [...document.querySelectorAll(selector)];
  const sceneIds = [
    "#scene-hook",
    "#scene-thought",
    "#scene-transform",
    "#scene-week",
    "#scene-approval",
    "#scene-cta",
  ];

  timeline.set(sceneIds, {autoAlpha: 0});
  timeline.set("#scene-hook", {autoAlpha: 1}, 0);
  timeline.set(".caption-page", {autoAlpha: 0, y: 15});
  timeline.set(".spine-line", {scaleY: 0});
  timeline.set(".spine-node", {y: 0});

  const revealScene = (selector, at) => {
    timeline.set(selector, {autoAlpha: 1}, at);
    timeline.fromTo(
      `${selector} > :not(.approval-field):not(.cta-wipe)`,
      {autoAlpha: 0, y: 28},
      {autoAlpha: 1, y: 0, duration: .44, stagger: .045, ease: "power2.out"},
      at + .04,
    );
  };

  const retireScene = (selector, at, direction = -24) => {
    timeline.to(selector, {autoAlpha: 0, y: direction, duration: .26, ease: "power2.in"}, at);
  };

  // A single yellow signal links the six scenes.
  timeline.to(".spine-line", {scaleY: 1, duration: 23.58, ease: "none"}, 0);
  timeline.to(".spine-node", {y: 1920, duration: 23.58, ease: "none"}, 0);

  // Beat 1.
  timeline.fromTo(".hook-slug", {autoAlpha: 0, x: -46}, {autoAlpha: 1, x: 0, duration: .34, ease: "power3.out"}, .03);
  timeline.fromTo(".hook-title span", {autoAlpha: 0, y: 72}, {autoAlpha: 1, y: 0, duration: .35, ease: "power3.out"}, .06);
  timeline.fromTo(".hook-title em", {autoAlpha: 0, y: 72}, {autoAlpha: 1, y: 0, duration: .35, ease: "power3.out"}, .12);
  timeline.fromTo(".voice-note", {autoAlpha: 0, y: 110, rotate: -7}, {autoAlpha: 1, y: 0, rotate: -2.5, duration: .78, ease: "power3.out"}, .58);
  timeline.fromTo(".voice-ring", {autoAlpha: 0, scale: .72}, {autoAlpha: 1, scale: 1, duration: .95, ease: "power2.out"}, .45);
  timeline.to(".voice-ring", {rotation: 17, duration: 4.1, ease: "none"}, .58);
  timeline.fromTo(".fragment", {autoAlpha: 0, scale: .8}, {autoAlpha: 1, scale: 1, duration: .38, stagger: .16, ease: "back.out(1.7)"}, .96);
  qa(".waveform i").forEach((bar, index) => {
    timeline.fromTo(
      bar,
      {scaleY: .2, opacity: .35},
      {
        scaleY: .72 + ((index * 7) % 9) / 6,
        opacity: 1,
        duration: .18 + (index % 3) * .04,
        repeat: 12,
        yoyo: true,
        ease: "sine.inOut",
      },
      .72 + index * .016,
    );
  });
  timeline.to(".fragment-a", {x: -24, y: 18, duration: 3.3, ease: "sine.inOut"}, 1.1);
  timeline.to(".fragment-b", {x: 22, y: -20, duration: 2.9, ease: "sine.inOut"}, 1.2);
  timeline.to(".fragment-c", {x: -18, y: -16, duration: 3.1, ease: "sine.inOut"}, 1.0);
  retireScene("#scene-hook", 4.5);

  // Beat 2.
  revealScene("#scene-thought", 4.8);
  timeline.fromTo(".thought-strip", {x: 900}, {x: 0, duration: .62, ease: "power4.out"}, 5.03);
  timeline.fromTo(".thought-strip p", {clipPath: "inset(0 100% 0 0)"}, {clipPath: "inset(0 0% 0 0)", duration: .8, ease: "power2.out"}, 5.42);
  timeline.to(".thought-caret", {autoAlpha: 0, duration: .16, repeat: 6, yoyo: true}, 5.46);
  timeline.fromTo("#handoff-path", {strokeDasharray: 720, strokeDashoffset: 720}, {strokeDashoffset: 0, duration: .68, ease: "power2.out"}, 6.35);
  timeline.fromTo(".arrow-tip", {autoAlpha: 0, x: -20}, {autoAlpha: 1, x: 0, duration: .28}, 6.86);
  retireScene("#scene-thought", 7.48);

  // Beat 3.
  revealScene("#scene-transform", 7.75);
  timeline.fromTo(".block-angle", {x: -500}, {x: 0, duration: .56, ease: "power3.out"}, 7.95);
  timeline.fromTo(".transform-mark", {autoAlpha: 0, scale: .45}, {autoAlpha: 1, scale: 1, duration: .43, ease: "back.out(1.8)"}, 8.33);
  timeline.to(".transform-mark i", {rotation: 180, duration: 1.6, ease: "none"}, 8.36);
  timeline.fromTo(".block-draft", {x: 500}, {x: 0, duration: .58, ease: "power3.out"}, 8.52);
  timeline.fromTo(".proof-rule", {autoAlpha: 0, scaleX: .72}, {autoAlpha: 1, scaleX: 1, duration: .45}, 9.22);
  timeline.to(".block-angle", {y: -8, duration: .7, yoyo: true, repeat: 1, ease: "sine.inOut"}, 9.25);
  timeline.to(".block-draft", {y: 8, duration: .7, yoyo: true, repeat: 1, ease: "sine.inOut"}, 9.25);
  retireScene("#scene-transform", 10.56);

  // Beat 4.
  revealScene("#scene-week", 10.85);
  timeline.fromTo(".week-spine", {scaleY: 0}, {scaleY: 1, duration: 1.08, ease: "power2.out"}, 11.08);
  timeline.fromTo(".issue", {autoAlpha: 0, x: 170}, {autoAlpha: 1, x: 0, duration: .5, stagger: .38, ease: "power3.out"}, 11.24);
  timeline.to(".issue-one", {x: 14, duration: 1.3, yoyo: true, repeat: 1, ease: "sine.inOut"}, 12.2);
  timeline.to(".issue-two", {x: -12, duration: 1.45, yoyo: true, repeat: 1, ease: "sine.inOut"}, 12.0);
  timeline.to(".issue-three", {x: 10, duration: 1.2, yoyo: true, repeat: 1, ease: "sine.inOut"}, 12.35);
  retireScene("#scene-week", 14.82);

  // Beat 5.
  timeline.to("#brand-rail, .folio", {autoAlpha: 0, duration: .18}, 15.05);
  timeline.set("#scene-approval", {autoAlpha: 1}, 15.15);
  timeline.fromTo(".approval-field", {scaleY: 0, transformOrigin: "bottom"}, {scaleY: 1, duration: .48, ease: "power3.inOut"}, 15.15);
  timeline.fromTo(".scene-approval .section-number, .scene-approval .kicker", {autoAlpha: 0, y: 22}, {autoAlpha: 1, y: 0, duration: .38, stagger: .08}, 15.48);
  timeline.fromTo(".approval-copy span", {autoAlpha: 0, x: -34}, {autoAlpha: 1, x: 0, duration: .38}, 15.66);
  timeline.fromTo(".approval-copy strong", {autoAlpha: 0, y: 70}, {autoAlpha: 1, y: 0, duration: .65, ease: "power3.out"}, 15.78);
  timeline.fromTo(".gate-track", {autoAlpha: 0}, {autoAlpha: 1, duration: .3}, 16.2);
  timeline.fromTo(".gate-track i", {scaleX: 0}, {scaleX: 1, duration: 1.28, ease: "power2.inOut"}, 16.3);
  timeline.fromTo(".gate-stop", {autoAlpha: 0, scale: .54}, {autoAlpha: 1, scale: 1, duration: .65, ease: "back.out(1.7)"}, 17.05);
  timeline.fromTo(".gate-label", {autoAlpha: 0, x: -42}, {autoAlpha: 1, x: 0, duration: .42}, 17.42);
  timeline.fromTo(".approval-note", {autoAlpha: 0, y: 25}, {autoAlpha: 1, y: 0, duration: .42}, 17.28);
  timeline.to(".gate-rings i", {scale: 1.18, opacity: .08, duration: .72, stagger: .1, repeat: 3, yoyo: true, ease: "sine.inOut"}, 17.6);
  timeline.to(".human-dot", {boxShadow: "0 0 0 18px rgba(42,22,70,.16)", duration: .55, repeat: 3, yoyo: true}, 18.1);
  retireScene("#scene-approval", 20.38);

  // Beat 6.
  timeline.set("#scene-cta", {autoAlpha: 1}, 20.65);
  timeline.fromTo(".cta-wipe", {scaleY: 0}, {scaleY: 1, duration: .48, ease: "power3.inOut"}, 20.65);
  timeline.fromTo(".cta-lockup", {autoAlpha: 0, y: 54}, {autoAlpha: 1, y: 0, duration: .62, ease: "power3.out"}, 20.86);
  timeline.fromTo(".cta-seal", {rotation: -18, scale: .6}, {rotation: 0, scale: 1, duration: .52, ease: "back.out(1.8)"}, 21.05);
  timeline.fromTo(".cta-url", {autoAlpha: 0, x: -32}, {autoAlpha: 1, x: 0, duration: .48, ease: "power2.out"}, 21.43);
  timeline.fromTo(".cta-rule", {autoAlpha: 0, scaleX: .72}, {autoAlpha: 1, scaleX: 1, duration: .5}, 21.62);
  timeline.to(".cta-seal", {rotation: 3, duration: 1.5, ease: "sine.inOut"}, 22.0);
  timeline.to(".cta-url b", {x: 7, y: -7, duration: .48, repeat: 2, yoyo: true, ease: "sine.inOut"}, 22.02);

  // Caption pages and active-word color changes are part of the same paused master timeline.
  for (const page of captionData.pages) {
    const element = pagesByCue.get(page.cueIndex);
    const enterAt = page.fromMs / 1000;
    const pageWords = [...element.querySelectorAll(".word")];
    timeline.fromTo(
      element,
      {autoAlpha: 0, y: 15},
      {autoAlpha: 1, y: 0, duration: .15, ease: "power2.out"},
      enterAt,
    );
    for (const token of captionData.tokens.filter((item) => item.cueIndex === page.cueIndex)) {
      const index = captionData.tokens
        .filter((item) => item.cueIndex === page.cueIndex)
        .findIndex((item) => item.fromMs === token.fromMs && item.text === token.text);
      timeline.set(
        pageWords,
        {color: (wordIndex) => wordIndex === index ? "#fcd20c" : "#fffefa"},
        token.fromMs / 1000,
      );
    }
    timeline.set(element, {autoAlpha: 0, y: -8}, page.toMs / 1000);
  }

  window.__timelines = window.__timelines || {};
  window.__timelines["myherald-one-thread"] = timeline;
})();
