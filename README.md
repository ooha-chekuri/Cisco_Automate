# Cisco NetAcad Study Assist

This is a conservative Playwright automation helper for repetitive Cisco NetAcad course navigation.

It is designed to assist with passive course flow only:

- Navigate content pages
- Scroll reading pages for a randomized 15-30 seconds using mouse-wheel and scroll-container fallbacks
- Play native video elements and wait for them to finish
- Click safe progression buttons
- Dismiss common cookie banners when they block the page

It does not answer quizzes or exams, submit forms, or spoof assessment completion.

## Setup

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

## Run

```powershell
$env:COURSE_URL="https://www.netacad.com/"
npm.cmd start
```

The browser opens visibly. Log in manually, navigate to the course module, then confirm in the terminal when you want the assistant to begin.

The assistant uses a persistent local Playwright profile at `.playwright-profile/netacad`, so after you log in once, future runs should usually reuse the same NetAcad session. This profile is separate from your normal Chrome browser profile, so logging into Google in your normal browser will not carry over automatically. You may still need to log in again if Cisco expires the session, you log out, clear the profile folder, or NetAcad requires fresh authentication.

If the page uses an embedded course viewer or inner scroll area, the assistant tries both mouse-wheel scrolling and DOM scroll-container scrolling. If it still cannot find a progression button, it saves a screenshot to `logs/` and leaves the browser open.

## Quiz Behavior

The assistant no longer scans whole page text for quiz/exam/assessment keywords because that can create false positives on normal content pages.

It still avoids obviously unsafe quiz controls such as submit/check/start-exam style buttons. If a quiz page has ordinary course navigation, the assistant may continue past it so you can return to complete it manually later.

## Useful Environment Variables

- `COURSE_URL`: Start URL. Defaults to `https://www.netacad.com/`.
- `MAX_STEPS`: Maximum loop iterations. Defaults to `200`.
- `REQUIRE_READING_CONFIRMATION`: Set to `true` to require manual confirmation before moving past reading pages.
- `MIN_SCROLL_SECONDS`: Minimum reading-page scroll duration. Defaults to `15`.
- `MAX_SCROLL_SECONDS`: Maximum reading-page scroll duration. Defaults to `30`.
- `VIDEO_MAX_WAIT_SECONDS`: Maximum time to wait for a video before continuing. Defaults to `1800`.
- `USER_DATA_DIR`: Browser profile folder used to keep login cookies/session storage. Defaults to `.playwright-profile/netacad`.
