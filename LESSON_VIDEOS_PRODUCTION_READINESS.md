# Lesson Videos (YouTube) — Production Readiness Audit

Audit date: 2026-11-11 · Branch: `perf/loading-reliability-and-tagline` (HEAD `17940da` + uncommitted lesson-video work)
Production today (read from each backend's `/api/health`): commit **`3e5b530`** on all three backends.

**Recommendation: GO, on three conditions** that can't be checked from this machine: confirm the deployed Render/Vercel settings (§3), take an Atlas backup (§6), and run the post-deploy checklist (§7). Every code-level check passes. Details follow.

---

## 1. Change inventory

### Shipped together (already committed, not yet deployed)
Deploying this branch also ships three commits that production doesn't have yet. They must be reviewed and released as part of this deploy:

| Commit | Subject |
|---|---|
| `7db5561` | Introduce the faculty from Admin, and give the About page tabs |
| `cd3faa6` | Stop the portals hanging on loads that never finish, and cut what they ship |
| `17940da` | Onboard teachers with a setup link, and show them every student in their courses (adds `CourseAccess`, `courseRoster.service.js`, which **teacher video permissions depend on**) |

`17940da` also contains one lesson-video line: the teacher socket forwards `course.access_changed`.

### Lesson-video work (uncommitted: 69 files = 25 modified + 44 new)
`git status` shows 62 lines because new folders collapse into one line each. The file-by-file list is in §10.
| Area | Files |
|---|---|
| Student backend | `utils/youtube.js`, `services/lessonVideo.service.js`, `controllers/lessonVideo.controller.js`, `validators/lessonVideo.validators.js`, `jobs/lessonVideoRecheck.job.js`; modified `models/Course.js` (optional `video` on lessons and modules), `controllers/course.controller.js` (student view + completion-timestamp fix), `routes/internal.routes.js`, `server.js` |
| Admin backend | `controllers/lessonVideo.controller.js`, `routes/lessonVideo.routes.js`; modified `routes/index.js`, `services/studentCourseBridge.service.js` |
| Teacher backend | `controllers/lessonVideo.controller.js`, `routes/lessonVideo.routes.js`, `services/lessonVideo.service.js`; modified `routes/index.js` |
| Student frontend | `components/student/LessonVideoPlayer.jsx`, `components/student/YouTubeThumbnail.jsx`, `utils/youtube.js`; modified `pages/student/ParambhCoursePage.jsx`, `vercel.json` |
| Admin frontend | `components/lessonVideos/*` (editor, manager, thumbnail), `pages/LessonVideosPage.jsx`, `utils/youtube.js`; modified `App.jsx`, `AdminSidebar.jsx`, `services/adminApi.js`, `vercel.json` |
| Teacher frontend | same components (byte-identical copies), `pages/LessonVideosPage.jsx`, `utils/youtube.js`; modified `App.jsx`, `TeacherLayout.jsx`, `services/teacherApiService.js`, `services/socketService.js` |
| Tests | student: `youtube.util`, `lessonVideo`, `courseVideo.resilience`, `videoBackwardCompat`; admin: `lessonVideo`; teacher: `lessonVideo` (+ fake-portal support in `tests/helpers/testApp.js`); frontends: Vitest suites incl. teacher `socketService.test.js`; root: `e2e/boot.mjs`, `e2e/lessonVideo.e2e.mjs` |

**Dependencies:** the three frontends gain dev-only dependencies (`vitest@3.2.4`, `jsdom@26.1.0`, `@testing-library/react@16.3.0`, `@testing-library/dom@10.4.0`, `@testing-library/jest-dom@6.6.3`) and a `test` script. The lockfiles were diffed against `HEAD`: **0 production dependencies added, changed or removed.** The backends' dependencies are unchanged.

**Hygiene:** no `.env`, key, certificate, dump or database file is in the change set. A pattern scan of every changed file found no credentials, apart from the throwaway test passwords used by the in-memory tests. All `.env` files are git-ignored. Built frontend bundles were scanned for every secret-looking value in the three backend `.env` files: **15 values checked, 0 found.**

---

## 2. Security findings

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| S1 | Admin CSP | `frame-src 'self'` blocked every YouTube preview on Vercel | High | **Fixed:** `https://www.youtube-nocookie.com` added |
| S2 | Student CSP | The whole policy was report-only, so nothing enforced which frames may load | Medium | **Fixed:** frame directives now enforced (`frame-src` limited to Google sign-in, Razorpay and YouTube; `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`). The rest stays report-only (see R4) |
| S3 | Concurrent edits | Two editors on one video: last write won silently | Medium | **Fixed:** every save/remove carries `expectedUpdatedAt`; a stale one gets 409 `VIDEO_CHANGED` with the current version, and nothing is written |
| S4 | Admin bridge | 4xx bodies cut to 200 characters, so long answers reached the admin as raw JSON and lost `details` | Low | **Fixed:** the full body is kept for parsing; the log excerpt stays short |
| S5 | Teacher socket URL | Fell back to `localhost:5002` when `VITE_SOCKET_URL` was unset, silently killing live updates | Medium (ops) | **Fixed:** derived from `VITE_TEACHER_API_URL` when unset |
| S6 | Completion timestamps | Re-marking a completed lesson overwrote `completedAt` (an existing bug) | Low (integrity) | **Fixed:** written only on first completion |
| S7 | Teacher "Live" badge | Showed "Reconnecting…" forever while the socket was connected: the session check opens the socket before the layout subscribes (an existing bug, found during acceptance) | Low (ops/UX) | **Fixed:** the socket service replays its last status to late subscribers; 4 unit tests |

Verified as designed (with tests):
- **Admin:** every video route needs a session and `courses.manage`. STAFF gets 403 on every route, and nothing refused reaches the student service.
- **Teacher:** session + `teacher` role + inactive-account check, then `CourseAccess(teacher, slug)` is read from the database **on every request**, for both lessons and modules. Upper-case or padded slugs are normalized before the check. Revoking an assignment blocks editing immediately. Refused edits never reach the student service.
- **Student:** draft videos (lesson or module) are never serialized, not even their ID. Public course endpoints use explicit field whitelists and never include `video`. The socket event carries IDs only, and only to students enrolled in that course. Non-enrolled students get 403.
- **Bridge:** `/api/internal/*` requires the service key (constant-time comparison). Unauthenticated calls get 401.
- **Input:** zod / express-validator on every write (URL ≤ 2048, enums, booleans, ISO version, slug regex). Objects in place of strings are rejected (no operator injection). YouTube links are validated by one parser (watch, youtu.be, embed, shorts, live). Bare IDs, embed code, other hosts, look-alike domains, credentials, ports and non-http schemes are all rejected.
- **iframes:** the only frame source is `https://www.youtube-nocookie.com/embed/<validated 11-char id>`, rebuilt in the browser from the ID and never taken from data. Frames are sandboxed (`allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox`). Player messages are accepted only when `origin` is the YouTube embed origin **and** `source` is that exact frame; only the numeric error code is read.
- **XSS:** titles and descriptions are stripped of markup on write and rendered as React text. Tests cover `<img onerror>` titles.
- **SSRF:** outbound calls only go to fixed YouTube hosts with a validated ID.
- **Audit:** admin and teacher saves, publishes and removals are written to each portal's audit log with slug, lesson/module, video IDs and the actor.

---

## 3. Production configuration

What could be checked from here (read-only, no secret values printed):
- All three production backends are healthy, but on commit `3e5b530`.
- The student backend's CORS allows `https://www.nalandanexus.com` (preflight answered 204).
- Locally, the admin and teacher keys equal the student's `INTERNAL_SERVICE_KEY`.

What could **not** be checked: the deployed Render and Vercel environment values. The local `.env` files are development configs (localhost bridges and CORS) pointing at the production Atlas cluster.

**Before deploying, confirm in Render / Vercel:**

| Service | Variable | Must be |
|---|---|---|
| Student backend (`nalandanexus.onrender.com`) | `INTERNAL_SERVICE_KEY` | set; equal to the next two |
| Admin backend (`nalandanexus-1.onrender.com`) | `STUDENT_BACKEND_URL` / `STUDENT_BACKEND_SERVICE_KEY` | `https://nalandanexus.onrender.com` / the student key |
| Teacher backend (`nalandanexus-1-bj7j.onrender.com`) | `STUDENT_BACKEND_URL` / `STUDENT_BACKEND_SERVICE_KEY` | as above |
| Admin backend | `TEACHER_BACKEND_URL` / `TEACHER_BACKEND_SERVICE_KEY` | the teacher backend / its key (needed by `17940da` course assignment) |
| Each backend | `CLIENT_URL` | its production frontend origin(s), comma-separated |
| Student frontend | `VITE_STUDENT_API_URL` | `https://nalandanexus.onrender.com/api` |
| Admin frontend | `VITE_ADMIN_API_URL`, `VITE_ADMIN_SOCKET_URL` | admin backend `/api/admin`, admin backend origin |
| Teacher frontend | `VITE_TEACHER_API_URL` (and `VITE_SOCKET_URL` if set) | teacher backend `/api/teacher`; the socket now falls back to the API origin |

No new environment variables. The student backend needs outbound HTTPS to `www.youtube.com` and `img.youtube.com` (Render allows this by default).

**CSP:** admin `frame-src 'self' https://www.youtube-nocookie.com`; teacher already allowed YouTube; student enforces the frame directives in S2, with the full policy still report-only. `img-src https:` on all three covers thumbnails.

---

## 4. YouTube validation

Live, against YouTube, on 2026-11-11:

| Case | Video | oEmbed | Thumbnail | Result |
|---|---|---|---|---|
| Public | `dQw4w9WgXcQ`, `M7lc1UVf-VE`, `aqz-KE-bpKQ` | 200 + title | 200 | available |
| Non-existent | `AAAAAAAAAAA` | 404 | 404 (grey placeholder) | unavailable |
| Malformed / non-existent | `zzzzzzzzzzz`, `0000000000a` | 400 | — | unavailable |
| Private / removed | `kYLlKasNbuk` | **403** | **404** | unavailable (cannot be published) |
| Public, embedding disabled | *no confirmed example found* | expected 401/403 | 200 | restricted (publishable, "Watch on YouTube") |

Because 401/403 means either "embedding disabled" or "not public", the service settles it with the `hqdefault` thumbnail (missing = not public). The save-time path for a *public* embed-disabled video is **not live-verified**: no such video could be found. It's covered by tests, and the player's playback-time detection (error 101/150, live-verified below) catches it either way.

**Live in-browser player checks (2026-11-11), through the real student component:**
- Public video → YouTube reported `onReady`, state 1 (**playing**), 9.6 s played, no errors.
- Private video `kYLlKasNbuk` → YouTube reported **error 150**; the component removed the frame and showed the explanation plus "Watch on YouTube". YouTube uses 150 for private videos as well as embed-disabled ones, so the message now names both.

**Failure handling (tested with stubs):** 429 → `unknown` plus a 60 s pause (no further requests); 5xx, timeout (4 s) and network error → `unknown`. A save never fails because YouTube is down. The hourly re-check changes nothing on an `unknown` answer. No portal UI depends on YouTube being reachable.

---

## 5. Limitations from the previous round — all addressed

| Limitation | Resolution |
|---|---|
| Lesson videos only | **Module introduction videos**: same editor and rules, shown to students as the first item of the module (no completion, no XP) |
| Availability not checked against live YouTube | Probed live (above); 401/403 disambiguated by thumbnail; 429 pause added |
| Owner changes after saving went unnoticed | **Hourly re-check** of published videos (batch of 40, each about once a day; definite answers only; never auto-unpublishes; can't overwrite an editor's save) **plus** in-player detection of YouTube errors 100/101/150 → explanation and "Watch on YouTube" |
| Simultaneous edits: last write won | Version-checked saves and removals (409 + current version + "Load the current version") |
| Student CSP report-only | Frame directives enforced; full policy still report-only (R4) |
| Teacher "Reconnecting…" badge | Two causes. The test setup left the socket URL on its localhost default, now derived from the API URL (S5). There was also a real, pre-existing bug where the badge missed the `connect` event, now fixed (S7) |
| Teacher auth relied on uncommitted work | Now committed in `17940da` |

---

## 6. Deployment plan

**Order: student backend → teacher backend → admin backend → student frontend → teacher frontend → admin frontend.** One at a time, verifying each before the next.

Why this order: the student backend only *adds* endpoints and fields, and older admin/teacher code never calls them. The teacher backend must be up before the admin backend, because `17940da` makes the admin push course assignments to new teacher endpoints. Each frontend goes after its backend, so no UI ever calls a route that doesn't exist yet. The student frontend tolerates an old backend (no `video` field → hosted file, as before).

0. **Pre-flight.** Atlas on-demand snapshot of the cluster (at minimum `nalanda_student`: `courses`, `lessonprogresses`, `xpevents`, `progressionevents`, `studentprofiles`, `enrollments`). Note the current Render deploy for each service (`3e5b530`) and the current Vercel deployment for each frontend. Confirm the §3 table. Get the three companion commits reviewed.
1. **Student backend.** Deploy, then check `/api/health` reports the new commit. Open an existing course as a student: lessons show as before. The hourly re-check first runs 5 minutes after boot.
2. **Teacher backend.** Deploy, check `/api/health`.
3. **Admin backend.** Deploy, check `/api/health`. Signed in as an admin: Admin → Lesson Videos lists PRARAMBH, GARUD, YODDHA.
4. **Student frontend.** Deploy. Check response headers contain the enforced `Content-Security-Policy` (frame directives) next to the report-only one. Check Google sign-in and a Razorpay checkout still open (they're on the frame allow-list).
5. **Teacher frontend.** Deploy. The "Live" badge connects (socket on the API origin).
6. **Admin frontend.** Deploy. The editor preview plays (CSP).
7. **Operator step:** in Admin → Teachers, assign PRARAMBH / GARUD / YODDHA to each teacher. `CourseAccess` rows (from `17940da`) only exist after this, and a teacher's Lesson Videos page lists only these courses.

**Sessions and sockets.** No secret or cookie changes, so existing admin, teacher and student sessions survive. Each backend restart drops its sockets; clients reconnect automatically, and the student page also refreshes when the tab regains focus. Render cold starts are covered by the existing retry budgets; the frontends give lesson-video calls the 45 s cold-start timeout.

**Data migration.** None. `video` is an optional subdocument; lessons and modules without it behave exactly as before (proven in §8).

### Rollback
- **Frontends:** Vercel → Deployments → previous → *Instant Rollback*. Safe in any order.
- **Backends:** Render → previous deploy (`3e5b530`) → *Rollback*, in reverse order (admin → teacher → student). Old code ignores the new `video` fields: Mongoose writes only modified paths, so they stay intact for a later redeploy. If only the student backend is rolled back, the Lesson Videos pages show "could not load" (the bridge returns 404) and nothing else is affected.
- **Data:** none needed. To hide every video at once without a rollback, unpublish from the UI. A bulk unset (`modules.video`, `modules.lessons.video`) needs explicit approval under the production write gates. Progress, XP and completions are never touched by this feature, so there's nothing to restore.

---

## 7. Acceptance results (pre-deploy)

**There is no staging environment** in this project's infrastructure, and nothing was deployed. The acceptance list was run on a **local staging-equivalent**: the three real backends as separate processes on isolated in-memory databases, wired with a shared service key exactly as in production, plus the three real frontends in a browser. These results don't replace a post-deploy check on the real infrastructure (§6, steps 1–7).

| # | Check | How it was verified | Result |
|---|---|---|---|
| 1 | Admin creates a YouTube video | Admin UI: pasted a link → instant thumbnail and validation → module introduction | ✅ |
| 2 | Admin publishes it | Admin UI "Publish" → confirmation banner and "Published" pill | ✅ |
| 3 | Teacher sees only assigned courses | Teacher UI course list = `PRARAMBH` only (assigned via the real `/teachers/courses` bridge); E2E: GARUD and YODDHA → 403 | ✅ |
| 4 | Teacher publishes a video | Teacher UI "Publish" on a lesson → confirmation | ✅ |
| 5 | Student sees the correct thumbnail | Student page: `img.youtube.com/vi/<the published id>/maxresdefault.jpg` | ✅ |
| 6 | Student plays the video | Real component: YouTube state 1, 9.6 s, no errors | ✅ |
| 7 | Updates sync automatically | Admin changed the URL while the student page was open → new thumbnail and title, **no reload**, same lesson | ✅ |
| 8 | Drafts stay private | Admin saved a draft → player gone live; the draft's ID and title are absent from the page **and** from the student's own API response | ✅ |
| 9 | Removal doesn't reset completion | After removal: "Lesson Completed" still shown | ✅ |
| 10 | No XP for video changes | Student points 10 before → 10 after swap, draft and removal | ✅ |
| 11 | Lessons without videos still work | Video-less lesson: text, task and notes shown; no player, no `<video>`, no broken image | ✅ |
| 12 | Mobile layout | 375 px: student page and admin editor have no horizontal scroll (scrollWidth = 375) | ✅ |

Also seen in the browser: module introductions (syllabus entry, no completion button), the in-player fallback for a private video (live), and the teacher "Live" badge after fix S7 with `VITE_SOCKET_URL` unset (the socket used the API origin).

---

## 8. Test results

Final runs, all sequential, `NODE_ENV=test`, in-memory databases (no production access):

| Suite | Result |
|---|---|
| Student backend (whole suite) | **292 / 292** |
| Admin backend (whole suite) | **114 / 114** |
| Teacher backend (whole suite) | **134 / 134** |
| Student frontend (Vitest) | **20 / 20** |
| Admin frontend (Vitest) | **23 / 23** |
| Teacher frontend (Vitest) | **9 / 9** |
| Cross-portal E2E (`npm run test:e2e:lesson-videos`) | **18 / 18** |
| Production builds (all three frontends) | ✅ |

The **production-shaped backward-compatibility test** (`student/backend/tests/videoBackwardCompat.integration.test.js`) builds PRARAMBH as `seed.js` defines it, plus GARUD and YODDHA through the real seeders (18 modules each, with quizzes, assessments and assignments). Three students complete lessons and earn XP through the real endpoints. It then runs more than 40 video operations: lesson and module videos, drafts, publishes, URL changes, refused stale saves, unpublishes, removals and a re-check pass. Afterwards it confirms these are **identical** to before: every module and lesson field (IDs, order, titles, content, locks, subjects), every `LessonProgress` row **including `completedAt`**, every XP event, every progression event, every student profile, every enrollment, every quiz and every task, plus each student's full course view apart from videos. The only change is the hosted file cleared by an explicit removal, which is the documented behavior.

A real production copy was **not** used: it contains student personal data, and copying it needs your explicit approval under the production write and approval gates.

---

## 9. Remaining risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Deployed Render/Vercel settings not verified | §3 checklist before deploy |
| R2 | No staging environment; acceptance was local | Post-deploy checklist §6; easy rollback |
| R3 | Three undeployed companion commits ship together | Review them; the full suites (which cover them) pass |
| R4 | Student site: only frame directives enforced; scripts/styles still report-only | Collect report-only violations, then enforce in a separate change |
| R5 | Save-time classification of a *public* embed-disabled video not live-verified (no example available) | In-player detection live-verified (error 150); daily re-check |
| R6 | YouTube oEmbed behavior could change | Unknown answers never block saves; player fallback |
| R7 | Teachers see no courses until admins assign them | Operator step §6.7 |
| R8 | Any signed-in editor can make the student service query YouTube (`inspect`) | App rate limiters + 429 pause |
| R9 | With several Render instances, each runs the hourly re-check | Harmless: version-guarded writes, small batches |

---

## 10. Release checklist (prepared 2026-11-11; nothing committed, pushed or deployed)

### 10.1 Repository state
- Branch `perf/loading-reliability-and-tagline` at `17940da` (already on `origin`). **Nothing staged**, no deletions, no stashes.
- `origin/main` = **`3e5b530`** = what production runs. Local `main` has one unpushed commit (`7db5561`), which this branch also contains.
- Second worktree `teacher/.claude/worktrees/friendly-meitner-79e8db`: clean, at an unrelated commit `c45f15d`, left untouched.
- `CourseAccess.js` and `courseRoster.service.js` are committed in `17940da` with no pending edits.
- No unrelated user changes are pending. Seven pending files also appear in the undeployed commits; their only removed lines are the two `COLD_START_PATHS` definitions, each replaced by a version that adds `/lesson-videos`.
- Secrets: 69 files scanned. No `.env`, key, dump, `dist` or `node_modules` files; no credential patterns; 0 of 15 backend `.env` secret values present. All `.env` files are git-ignored.
- Lockfiles: each frontend lock root matches its `package.json`; 0 production packages added, changed or removed; `npm ls` clean. Backend `package.json` and lockfiles are unchanged.

### 10.2 Files ready for commit (69)
**Modified (25):** `package.json`;
`student/backend/src/{controllers/course.controller.js, models/Course.js, routes/internal.routes.js, server.js}`;
`admin/backend/src/{routes/index.js, services/studentCourseBridge.service.js}`;
`teacher/backend/src/routes/index.js`, `teacher/backend/tests/helpers/testApp.js`;
`student/frontend/{package.json, package-lock.json, vercel.json, src/pages/student/ParambhCoursePage.jsx}`;
`admin/frontend/{package.json, package-lock.json, vercel.json, src/App.jsx, src/components/layout/AdminSidebar.jsx, src/services/adminApi.js}`;
`teacher/frontend/{package.json, package-lock.json, src/App.jsx, src/components/TeacherLayout.jsx, src/services/socketService.js, src/services/teacherApiService.js}`.

**New (44):** `LESSON_VIDEOS_PRODUCTION_READINESS.md`; `e2e/{boot.mjs, lessonVideo.e2e.mjs}`;
`student/backend/src/{controllers/lessonVideo.controller.js, jobs/lessonVideoRecheck.job.js, services/lessonVideo.service.js, utils/youtube.js, validators/lessonVideo.validators.js}`;
`student/backend/tests/{courseVideo.resilience.integration, lessonVideo.integration, videoBackwardCompat.integration, youtube.util}.test.js`;
`admin/backend/src/{controllers/lessonVideo.controller.js, routes/lessonVideo.routes.js}`, `admin/backend/tests/lessonVideo.integration.test.js`;
`teacher/backend/src/{controllers/lessonVideo.controller.js, routes/lessonVideo.routes.js, services/lessonVideo.service.js}`, `teacher/backend/tests/lessonVideo.integration.test.js`;
`student/frontend/{vitest.config.js, src/test-setup.js, src/utils/youtube.js, src/components/student/LessonVideoPlayer.jsx, src/components/student/LessonVideoPlayer.test.jsx, src/components/student/YouTubeThumbnail.jsx, src/pages/student/ParambhCoursePage.test.jsx}`;
`admin/frontend/{vitest.config.js, src/test-setup.js, src/utils/youtube.js, src/pages/LessonVideosPage.jsx}` and `admin/frontend/src/components/lessonVideos/{LessonVideoEditor, LessonVideoEditor.test, LessonVideoManager, LessonVideoManager.test, YouTubeThumbnail}.jsx`;
`teacher/frontend/{vitest.config.js, src/test-setup.js, src/utils/youtube.js, src/services/socketService.test.js, src/pages/LessonVideosPage.jsx, src/pages/LessonVideosPage.test.jsx}` and `teacher/frontend/src/components/lessonVideos/{LessonVideoEditor, LessonVideoManager, YouTubeThumbnail}.jsx`.

### 10.3 Commits ahead of production
Production = `3e5b530`. Shipping this branch also ships `7db5561` (faculty on About), `cd3faa6` (loading reliability), `17940da` (teacher onboarding + `CourseAccess`), plus the lesson-video commit once approved.

### 10.4 Final test results (sequential, `NODE_ENV=test`, in-memory databases)
Student backend 292/292 · Admin backend 114/114 · Teacher backend 134/134 · Student frontend 20/20 · Admin frontend 23/23 · Teacher frontend 9/9 · production builds ×3 ✅ · cross-portal E2E 18/18.

### 10.5 Deployment blockers (resolve before deploying)
| # | Blocker | Action |
|---|---|---|
| B1 | Not committed | Your approval to commit the 69 files above |
| B2 | Release path: production follows `origin/main` (`3e5b530`); this branch is not merged. If Render and Vercel auto-deploy from `main`, a merge deploys **all six apps at once**, ignoring the required order | Open a PR to `main`. Before merging, pause auto-deploy on the 3 Render services and 3 Vercel projects (or confirm it's off), then deploy manually in the §6 order |
| B3 | Deployed settings unverified (R1) | Check §10.6 and §10.7 in the dashboards |
| B4 | No database backup yet | Atlas on-demand snapshot (§10.8) |
| B5 | Three companion commits ship unreviewed | Review `7db5561`, `cd3faa6`, `17940da` |

Not blockers: the unpushed local `main` commit (already on this branch); the clean second worktree; no staging (mitigated by §10.10 and rollback).

### 10.6 Render (three web services) — confirm, don't change secrets
| Setting | Student (`nalandanexus.onrender.com`) | Teacher (`nalandanexus-1-bj7j.onrender.com`) | Admin (`nalandanexus-1.onrender.com`) |
|---|---|---|---|
| Root directory | `student/backend` | `teacher/backend` | `admin/backend` |
| Build / start | `npm ci` (or `npm install`) / `npm start` (`node src/server.js`) | same | same |
| Node | ≥ 18 (`fetch` is used); 20 or 22 recommended | same | same |
| Health check | `/api/health` | `/api/health` | `/api/health` |
| `NODE_ENV` | `production` | `production` | `production` |
| Database | `MONGODB_URI` → `nalanda_student` | → `nalanda_teacher` | → `nalanda_admin` |
| Service keys | `INTERNAL_SERVICE_KEY` = K | `STUDENT_BACKEND_SERVICE_KEY` = K | `STUDENT_BACKEND_SERVICE_KEY` = K; `TEACHER_BACKEND_SERVICE_KEY` = the teacher's inbound key |
| Bridges | (`TEACHER_BACKEND_URL`, `ADMIN_BACKEND_URL` as today) | `STUDENT_BACKEND_URL=https://nalandanexus.onrender.com` | `STUDENT_BACKEND_URL=https://nalandanexus.onrender.com`; `TEACHER_BACKEND_URL=https://nalandanexus-1-bj7j.onrender.com` |
| `CLIENT_URL` | `https://www.nalandanexus.com,https://nalandanexus.com,https://nalandanexus.vercel.app` (as today) | the teacher frontend's production origin | **exactly one** origin: the admin frontend's production origin (admin CORS accepts a single origin) |
| Outbound | HTTPS to `www.youtube.com`, `img.youtube.com` (default) | — | — |
| Auto-deploy | Paused for the release (B2) | Paused | Paused |

No new variables are introduced by lesson videos.

### 10.7 Vercel (three projects)
| Setting | Student | Teacher | Admin |
|---|---|---|---|
| Root directory | `student/frontend` | `teacher/frontend` | `admin/frontend` |
| Framework / build / output | Vite / `npm run build` / `dist` | same | same |
| Env (Production) | `VITE_STUDENT_API_URL=https://nalandanexus.onrender.com/api` | `VITE_TEACHER_API_URL=https://nalandanexus-1-bj7j.onrender.com/api/teacher` (`VITE_SOCKET_URL` optional; falls back to the API origin) | `VITE_ADMIN_API_URL=https://nalandanexus-1.onrender.com/api/admin`, `VITE_ADMIN_SOCKET_URL=https://nalandanexus-1.onrender.com` |
| Headers | from `vercel.json`: enforced frame CSP + report-only full CSP | unchanged `vercel.json` (already allows YouTube frames) | from `vercel.json`: `frame-src 'self' https://www.youtube-nocookie.com` |
| Check | No dashboard-level header overrides that would replace `vercel.json` | same | same |
| Auto-deploy | Paused for the release (B2) | Paused | Paused |

`VITE_*` values are compiled into the bundle, so after changing one, redeploy that project.

### 10.8 Atlas backup (required before step 1)
Take an on-demand snapshot of the cluster, or at minimum a `mongodump` of `nalanda_student` (`courses`, `lessonprogresses`, `xpevents`, `progressionevents`, `studentprofiles`, `enrollments`) plus `nalanda_teacher.courseaccesses` and `nalanda_admin.teachers`. Record the snapshot ID and time in the release notes. This is the operator's step; nothing here touches production.

### 10.9 Order and rollback
Order: **student backend → teacher backend → admin backend → student frontend → teacher frontend → admin frontend → operator assigns courses to teachers** (§6), one at a time, checking `/api/health` (backends) or the page (frontends) before the next.
Rollback: Vercel *Instant Rollback* per project (any order). Render *Rollback* to the `3e5b530` deploy in reverse order (admin → teacher → student). No data rollback is needed: new `video` fields are ignored by old code and kept for a later redeploy; progress, XP and completions are never written by this feature. Hiding all videos without a rollback = unpublish in the UI; any bulk database change needs explicit approval.

### 10.10 Post-deployment acceptance (production)
Use a **dedicated test student account** enrolled in PRARAMBH, and a lesson where publishing a video is intended anyway (real enrolled students will see what you publish). Never mark lessons complete as a real student.
1. ☐ All three `/api/health` report the new commit, with `database: connected`.
2. ☐ Existing lessons open for the test student exactly as before (hosted `/PRARAMBH.mp4` lessons still play).
3. ☐ Admin → Lesson Videos lists PRARAMBH, GARUD, YODDHA.
4. ☐ Admin pastes a link → thumbnail appears instantly; status says "Valid YouTube video · embedding allowed" (the live YouTube check now runs).
5. ☐ Admin preview plays inside the admin page (no CSP block).
6. ☐ Admin publishes → the test student's open page updates without a reload; correct thumbnail; Play runs inside the page; fullscreen works; "Open on YouTube" opens a new tab.
7. ☐ Admin saves a draft on another lesson → nothing appears for the student.
8. ☐ Admin assigns PRARAMBH to a test teacher in Admin → Teachers → the teacher's Lesson Videos page lists **only** PRARAMBH; the "Live" badge shows Live.
9. ☐ The teacher publishes a video → the student sees it; the teacher can't open GARUD or YODDHA (absent from the list; direct API → 403).
10. ☐ Test student completes a lesson (+10 XP once) → admin changes, then removes that lesson's video → still "Lesson Completed", XP unchanged.
11. ☐ A module introduction appears as the first syllabus item and has no completion button.
12. ☐ Student site: Google sign-in and Razorpay checkout still open (enforced `frame-src`); response headers show both CSP headers.
13. ☐ Phone width: student lesson page and admin editor have no horizontal scroll.
14. ☐ About 5 minutes after the student backend boots, its log shows the lesson-video re-check running, or nothing if there are no stale videos (no errors).
15. ☐ Remove or unpublish any test videos added in steps 4–11 that shouldn't stay visible.
