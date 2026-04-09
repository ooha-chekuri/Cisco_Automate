import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const COURSE_URL = process.env.COURSE_URL || "https://www.netacad.com/";
const MAX_STEPS = Number.parseInt(process.env.MAX_STEPS || "200", 10);
const REQUIRE_READING_CONFIRMATION = process.env.REQUIRE_READING_CONFIRMATION === "true";
const MIN_SCROLL_SECONDS = Number.parseInt(process.env.MIN_SCROLL_SECONDS || "15", 10);
const MAX_SCROLL_SECONDS = Number.parseInt(process.env.MAX_SCROLL_SECONDS || "15", 10);
const VIDEO_MAX_WAIT_SECONDS = Number.parseInt(process.env.VIDEO_MAX_WAIT_SECONDS || "500", 10);
const VIDEO_PLAYBACK_RATE = Number.parseFloat(process.env.VIDEO_PLAYBACK_RATE || "3");
const VIDEO_MUTED = process.env.VIDEO_MUTED !== "false";
const LOG_DIR = path.resolve("logs");
const USER_DATA_DIR = path.resolve(process.env.USER_DATA_DIR || ".playwright-profile/netacad");

const rl = readline.createInterface({ input, output });

const UNSAFE_ASSESSMENT_ACTIONS = [
  "submit",
  "submit answer",
  "submit quiz",
  "finish attempt",
  "finish review",
  "check",
  "check answer",
  "grade",
  "start quiz",
  "start exam",
  "start assessment",
  "retake",
  "attempt quiz",
  "attempt exam",
  "attempt assessment"
];

const PROGRESS_ACTIONS = [
  "next",
  "next page",
  "next lesson",
  "next topic",
  "continue",
  "mark complete"
];

const COOKIE_DISMISS_ACTIONS = [
  "accept",
  "accept all",
  "agree",
  "got it",
  "ok",
  "close"
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askUser(message, defaultNo = true) {
  const suffix = defaultNo ? "[y/N]" : "[Y/n]";
  const answer = await rl.question(`${message} ${suffix} `);
  const normalized = answer.trim().toLowerCase();

  if (!normalized) {
    return !defaultNo;
  }

  return normalized === "y" || normalized === "yes";
}

async function ensureLogDir() {
  await fs.mkdir(LOG_DIR, { recursive: true });
}

async function classifyPage(page) {
  await dismissCookieBanners(page);

  const title = await page.title().catch(() => "");
  const hasVideo = await hasVisibleVideo(page);

  if (hasVideo) {
    return {
      type: "video",
      title
    };
  }

  return {
    type: "reading",
    title
  };
}

async function findByAccessibleName(page, names) {
  const candidates = [];

  for (const frame of page.frames()) {
    candidates.push(...await findByAccessibleNameInFrame(frame, names));
  }

  return chooseBestProgressCandidate(candidates, page);
}

async function findByAccessibleNameInFrame(frame, names) {
  const candidates = [];

  for (const name of names) {
    const flexibleName = new RegExp(escapeRegExp(name), "i");
    const exactName = new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`, "i");
    const searchSpecs = [
      { locator: frame.getByRole("button", { name: exactName }), label: name, role: "button", match: "exact" },
      { locator: frame.getByRole("link", { name: exactName }), label: name, role: "link", match: "exact" },
      { locator: frame.getByRole("button", { name: flexibleName }), label: name, role: "button", match: "partial" },
      { locator: frame.getByRole("link", { name: flexibleName }), label: name, role: "link", match: "partial" }
    ];

    for (const spec of searchSpecs) {
      const count = await spec.locator.count().catch(() => 0);

      for (let index = 0; index < Math.min(count, 10); index += 1) {
        const locator = spec.locator.nth(index);

        if (await locator.isVisible().catch(() => false)) {
          candidates.push({
            locator,
            label: name,
            role: spec.role,
            match: spec.match
          });
        }
      }
    }
  }

  return candidates;
}

async function chooseBestProgressCandidate(candidates, page) {
  const viewport = page.viewportSize() || { width: 1366, height: 900 };
  const scored = [];

  for (const candidate of candidates) {
    const details = await getCandidateDetails(candidate);

    if (!details || isNonForwardNavigation(details.combinedText)) {
      continue;
    }

    let score = 0;
    const text = details.combinedText;

    if (/\bnext\b/.test(text)) score += 1000;
    if (/next\s+(page|lesson|topic|section)/.test(text)) score += 250;
    if (/\bcontinue\b/.test(text)) score += 700;
    if (/mark\s+complete/.test(text)) score += 450;
    if (candidate.match === "exact") score += 150;
    if (candidate.role === "button") score += 80;

    const box = details.box;

    if (box) {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;

      if (centerX > viewport.width * 0.5) score += 180;
      if (centerX > viewport.width * 0.72) score += 220;
      if (centerY > viewport.height * 0.45) score += 120;
      if (centerY > viewport.height * 0.7) score += 120;
      if (centerX < viewport.width * 0.28) score -= 450;
      if (box.width > viewport.width * 0.45) score -= 200;
    }

    if (candidate.role === "link" && !/\bnext\b|continue/.test(text)) score -= 350;

    scored.push({ candidate, score, details });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best || best.score < 500) {
    return null;
  }

  console.log(`Selected progress control "${best.details.displayText}" with score ${best.score}.`);
  return {
    ...best.candidate,
    label: best.details.displayText || best.candidate.label
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isUnsafeAssessmentControl(candidate) {
  const details = await getCandidateDetails(candidate);
  const label = details?.combinedText || candidate.label.toLowerCase();
  const hasUnsafeAssessmentAction = UNSAFE_ASSESSMENT_ACTIONS.some((term) => label.includes(term));

  if (!hasUnsafeAssessmentAction) {
    return false;
  }

  // Do not block a real forward-navigation control just because surrounding
  // href/class text mentions a quiz or assessment module.
  return !isForwardNavigationText(label);
}

async function getCandidateDetails(candidate) {
  const [text, ariaLabel, title, dataTestId, className, href, box] = await Promise.all([
    candidate.locator.innerText({ timeout: 1000 }).catch(() => ""),
    candidate.locator.getAttribute("aria-label", { timeout: 1000 }).catch(() => ""),
    candidate.locator.getAttribute("title", { timeout: 1000 }).catch(() => ""),
    candidate.locator.getAttribute("data-testid", { timeout: 1000 }).catch(() => ""),
    candidate.locator.getAttribute("class", { timeout: 1000 }).catch(() => ""),
    candidate.locator.getAttribute("href", { timeout: 1000 }).catch(() => ""),
    candidate.locator.boundingBox().catch(() => null)
  ]);

  const displayText = [text, ariaLabel, title, dataTestId]
    .filter(Boolean)
    .join(" ")
    .trim();
  const combinedText = [
    candidate.label,
    text,
    ariaLabel,
    title,
    dataTestId,
    className,
    href
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return {
    box,
    combinedText,
    displayText: displayText || candidate.label
  };
}

function isNonForwardNavigation(text) {
  return /\b(previous|prev|back|contents|menu|home|overview|first|start over)\b/.test(text);
}

function isForwardNavigationText(text) {
  return /\b(next|continue|mark complete)\b/.test(text);
}

async function clickAndWait(candidate, page) {
  console.log(`Clicking ${candidate.role}: "${candidate.label}"`);

  await Promise.allSettled([
    page.waitForLoadState("domcontentloaded", { timeout: 10000 }),
    candidate.locator.click({ timeout: 10000 })
  ]);

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await delay(1200);
}

async function handleVideoPage(page) {
  const video = await firstVisibleVideo(page);

  if (!video) {
    console.log("Video was detected earlier, but it is no longer visible. Continuing to timed scroll.");
    await handleReadingPage(page);
    return;
  }

  console.log(`Video detected. Attempting playback at ${VIDEO_PLAYBACK_RATE}x with ${VIDEO_MUTED ? "mute on" : "sound on"} and waiting for normal completion.`);

  const started = await video.evaluate((element, { playbackRate, muted }) => {
    element.playbackRate = playbackRate;
    element.muted = muted;
    return element.play()
      .then(() => true)
      .catch(() => false);
  }, { playbackRate: VIDEO_PLAYBACK_RATE, muted: VIDEO_MUTED }).catch(() => false);

  if (!started) {
    console.log("The browser blocked scripted playback. Please press play manually in the visible browser.");
  }

  const completed = await waitForVideoCompletion(video, VIDEO_MAX_WAIT_SECONDS);

  if (completed) {
    console.log("Video completion detected. Scrolling before continuing.");
  } else {
    console.log("Video completion was not detected before the timeout. Scrolling and continuing to safe navigation checks.");
  }

  await handleReadingPage(page);
}

async function waitForVideoCompletion(video, maxWaitSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let lastSecondLogged = -1;

  while (Date.now() < deadline) {
    const state = await video.evaluate((element) => ({
      currentTime: element.currentTime || 0,
      duration: element.duration || 0,
      ended: element.ended,
      paused: element.paused,
      readyState: element.readyState
    })).catch(() => null);

    if (!state) {
      await delay(2000);
      continue;
    }

    if (state.ended || (Number.isFinite(state.duration) && state.duration > 0 && state.currentTime >= state.duration - 1)) {
      return true;
    }

    const wholeSecond = Math.floor(state.currentTime);

    if (wholeSecond > 0 && wholeSecond !== lastSecondLogged && wholeSecond % 30 === 0) {
      lastSecondLogged = wholeSecond;
      console.log(`Video progress: ${formatSeconds(state.currentTime)} / ${formatSeconds(state.duration)}`);
    }

    if (state.paused && state.readyState >= 2) {
      await video.evaluate((element, { playbackRate, muted }) => {
        element.playbackRate = playbackRate;
        element.muted = muted;
        return element.play().catch(() => {});
      }, { playbackRate: VIDEO_PLAYBACK_RATE, muted: VIDEO_MUTED }).catch(() => {});
    }

    await delay(2000);
  }

  return false;
}

async function handleReadingPage(page) {
  const scrollSeconds = randomInt(MIN_SCROLL_SECONDS, MAX_SCROLL_SECONDS);
  console.log(`Reading/content page detected. Scrolling for ${scrollSeconds} seconds, then continuing.`);

  await dismissCookieBanners(page);
  await page.mouse.move(680, 450).catch(() => {});
  await scrollWithMouseWheel(page, scrollSeconds);
  await scrollScrollableDomContainers(page, Math.max(2, Math.floor(scrollSeconds / 3)));

  if (REQUIRE_READING_CONFIRMATION) {
    return askUser("Finished reviewing this page and ready to continue?");
  }

  return true;
}

async function scrollWithMouseWheel(page, scrollSeconds) {
  const deadline = Date.now() + scrollSeconds * 1000;
  let direction = 1;

  while (Date.now() < deadline) {
    await page.mouse.wheel(0, direction * randomInt(260, 640)).catch(() => {});
    await delay(randomInt(700, 1300));

    if (Math.random() < 0.12) {
      direction *= -1;
    }
  }
}

async function scrollScrollableDomContainers(page, passes) {
  for (let pass = 0; pass < passes; pass += 1) {
    await Promise.all(page.frames().map((frame) => scrollFrameDomContainers(frame)));
    await delay(randomInt(400, 900));
  }
}

async function scrollFrameDomContainers(frame) {
  await frame.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const candidates = [document.scrollingElement, document.documentElement, document.body]
      .concat(Array.from(document.querySelectorAll("*")))
      .filter((element) => {
        if (!element) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY);
        return canScrollY && element.scrollHeight > element.clientHeight + 20;
      })
      .slice(0, 8);

    for (const element of candidates) {
      element.scrollBy({ top: Math.max(240, Math.floor(window.innerHeight * 0.7)), behavior: "smooth" });
      await wait(120);
    }
  }).catch(() => {});
}

async function findProgressAction(page) {
  await dismissCookieBanners(page);

  const candidate = await findByAccessibleName(page, PROGRESS_ACTIONS)
    || await findProgressActionByAttributes(page);

  if (!candidate) {
    return null;
  }

  if (await isUnsafeAssessmentControl(candidate)) {
    console.log("The next available control looks assessment-related, so the assistant will not click it.");
    return null;
  }

  return candidate;
}

async function findProgressActionByAttributes(page) {
  const selector = [
    "button[aria-label*='next' i]",
    "a[aria-label*='next' i]",
    "[role='button'][aria-label*='next' i]",
    "button[title*='next' i]",
    "a[title*='next' i]",
    "[role='button'][title*='next' i]",
    "button[aria-label*='continue' i]",
    "a[aria-label*='continue' i]",
    "[role='button'][aria-label*='continue' i]",
    "button[title*='continue' i]",
    "a[title*='continue' i]",
    "[role='button'][title*='continue' i]",
    "button[class*='next' i]",
    "a[class*='next' i]",
    "[role='button'][class*='next' i]",
    "button[class*='continue' i]",
    "a[class*='continue' i]",
    "[role='button'][class*='continue' i]",
    "button[data-testid*='next' i]",
    "a[data-testid*='next' i]",
    "[role='button'][data-testid*='next' i]",
    "button[data-testid*='continue' i]",
    "a[data-testid*='continue' i]",
    "[role='button'][data-testid*='continue' i]"
  ].join(", ");

  const candidates = [];

  for (const frame of page.frames()) {
    const locator = frame.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const candidateLocator = locator.nth(index);

      if (!(await candidateLocator.isVisible().catch(() => false))) {
        continue;
      }

      const label = await candidateLocator.getAttribute("aria-label").catch(() => null)
        || await candidateLocator.getAttribute("title").catch(() => null)
        || await candidateLocator.getAttribute("data-testid").catch(() => null)
        || "next/continue";
      candidates.push({
        locator: candidateLocator,
        label,
        role: "attribute match",
        match: "attribute"
      });
    }
  }

  return chooseBestProgressCandidate(candidates, page);
}

async function dismissCookieBanners(page) {
  for (const frame of page.frames()) {
    const bodyText = await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");

    if (!/cookie|privacy/i.test(bodyText)) {
      continue;
    }

    const dismissCandidates = await findByAccessibleNameInFrame(frame, COOKIE_DISMISS_ACTIONS);
    const dismiss = dismissCandidates[0];

    if (dismiss && !(await isUnsafeAssessmentControl(dismiss))) {
      await dismiss.locator.click({ timeout: 2000 }).catch(() => {});
      await delay(500);
      return;
    }
  }
}

async function hasVisibleVideo(page) {
  return Boolean(await firstVisibleVideo(page));
}

async function firstVisibleVideo(page) {
  for (const frame of page.frames()) {
    const video = frame.locator("video").first();

    if (await video.isVisible().catch(() => false)) {
      return video;
    }
  }

  return null;
}

function randomInt(min, max) {
  const normalizedMin = Math.max(1, Math.min(min, max));
  const normalizedMax = Math.max(normalizedMin, max);
  return Math.floor(Math.random() * (normalizedMax - normalizedMin + 1)) + normalizedMin;
}

function formatSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "--:--";
  }

  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function run() {
  await ensureLogDir();
  await fs.mkdir(USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 100,
    viewport: { width: 1366, height: 900 }
  });

  const page = context.pages()[0] || await context.newPage();

  console.log(`Opening ${COURSE_URL}`);
  console.log(`Using persistent browser profile: ${USER_DATA_DIR}`);
  await page.goto(COURSE_URL, { waitUntil: "domcontentloaded" });

  console.log("Log in manually, navigate to the course/module, then return here.");
  const ready = await askUser("Start assisted navigation?", true);

  if (!ready) {
    console.log("Not starting. Browser remains open for manual use.");
    rl.close();
    return;
  }

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await delay(1000);

    const classification = await classifyPage(page);
    console.log(`\nStep ${step}: ${classification.type.toUpperCase()} | ${classification.title || page.url()}`);

    if (classification.type === "video") {
      await handleVideoPage(page);
    } else {
      const canContinue = await handleReadingPage(page);

      if (!canContinue) {
        console.log("Paused by user.");
        break;
      }
    }

    const progressAction = await findProgressAction(page);

    if (!progressAction) {
      await page.screenshot({ path: path.join(LOG_DIR, `no-progress-action-step-${step}.png`), fullPage: true }).catch(() => {});
      console.log("No safe Next/Continue action found. Screenshot saved and browser left open.");
      break;
    }

    await clickAndWait(progressAction, page);
  }

  console.log("\nStudy assistant stopped. The persistent browser is left open for inspection/manual work.");
  rl.close();
}

run().catch((error) => {
  console.error(error);
  rl.close();
  process.exitCode = 1;
});
