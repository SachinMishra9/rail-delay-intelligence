# Rail Delay Intelligence – Finland: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-page web app (published as a claude.ai artifact) that analyses Finnish open rail data scientifically, turns delay into € and Sweco opportunities, and writes client reports with Claude from custom templates.

**Architecture:** Static ES modules with no build step. `src/analysis.js` holds the pure, tested maths. `src/data.js` fetches from Digitraffic. `src/app.js` contains the UI (Leaflet map, Chart.js charts, panels). `src/report.js` handles templates and AI reports, and `src/export.js` the exports. Tests run in the browser (`tests/tests.html`, a tiny assert harness), because Node isn't installed on this machine.

**Tech Stack:** HTML/CSS/ES modules; Leaflet 1.9.4 and Chart.js 4.4.1 from cdnjs; Digitraffic REST API; artifact capabilities `sample`, `db`, `user`, `downloads`; local preview with `python3 -m http.server 8765`.

**Spec:** `docs/superpowers/specs/2026-11-24-rail-delay-intelligence-design.md`

## Global Constraints
- API base `https://rata.digitraffic.fi/api/v1`; send the header `Digitraffic-User: rail-delay-intelligence-demo`.
- Delays are computed in seconds from `actualTime − scheduledTime`, never from `differenceInMinutes`.
- Only rows with `actualTime` count; trains with category in {Shunting, Locomotive, On-track machines, Test drive} are excluded.
- On-time means delay ≤ 180 s at the final station.
- Defaults: VoT €15 per passenger-hour; load 250 (Long-distance) and 150 (Commuter); freight €2 per train-minute; bootstrap B=200, 95% CI; leverage cap 3.0.
- Every € figure is labelled "estimate" with its assumptions visible.
- Values from the API or Claude are inserted with textContent or escaped.
- Data attribution: "Source: Fintraffic / digitraffic.fi, CC BY 4.0".

## Review Focus
- A day with zero usable trains (API down / future date) → empty states, no NaN on screen. (Test in Task 1: `analyseDays([])`.)
- A section with n<5 → shown, but β = null and flagged "insufficient data". (Task 1 test.)
- A cancelled train or row (`cancelled: true`) → skipped. (Task 1 test.)
- An unavailable `sample`/`db` capability (running locally) → AI panel shows "AI needs the claude.ai page", templates fall back to localStorage. (Task 4 manual check.)
- Midnight-crossing trains → times are absolute ISO, so differences stay correct. (Task 1 test with a 23:58→00:04 run.)

---

### Task 1: Analysis core

**Files:** Create `src/analysis.js`, `tests/tests.html`, `tests/analysis.test.js`, `.claude/launch.json`

**Interfaces – Produces:**
- `extractRuns(train) -> {runs:[{from,to,dIn,dOut,gain}], dwells:[{st,gain,causes}], finalDelay}` (seconds)
- `theilSen(xs, ys) -> {alpha, beta}`
- `bootstrap(items, statFn, B=200, rng) -> {lo, hi}`
- `shrink(means, ns, globalMean, k) -> number[]` (empirical Bayes: `(n*m + k*g)/(n+k)`, with k = median n)
- `analyseDays(trains[], opts) -> {kpis, sections:Map<key,Section>, stations:Map, causes, dist}` where Section = `{key, from, to, n, created, recovered, alpha, beta, betaCI, shrunkMean, leverage, causeMix}`
- `costOf(analysis, assumptions, rng) -> {eur, lo, hi, paxHours}`
- `classifyCause(detailedCode) -> 'infrastructure'|'works'|'capacity'|'operator'|'other'`
- `mulberry32(seed)` seeded RNG, so tests are deterministic

- [ ] Step 1: Write tests: theilSen on y=2+0.5x with one outlier → beta≈0.5 (±0.01); extractRuns on a 3-station fixture with known times (including one over midnight) gives exact gains; a cancelled row is skipped; analyseDays([]) gives kpis.trains=0 and no NaN; a section with n=3 has beta=null; classifyCause('P1')='infrastructure', 'R2'='works', 'L3'='capacity', 'K2'='operator'.
- [ ] Step 2: Serve with preview (`python3 -m http.server 8765`), open `/tests/tests.html`, and confirm it shows FAIL.
- [ ] Step 3: Implement. Leverage for section s = the mean over trains passing s of Σ over that train's downstream sections of Π β_j (β clipped to [0, 1.5], sum capped at 3.0).
- [ ] Step 4: Reload the tests page → all PASS.
- [ ] Step 5: Commit.

### Task 2: Data layer

**Files:** Create `src/data.js`

**Produces:** `loadStations() -> Map<code,{name,lat,lon}>`, `loadDay(dateStr) -> train[]` (cached in memory), `loadLive() -> GeoJSON`, `loadCauseNames() -> Map<code,name>`.

- [ ] Step 1: Add a smoke test to tests.html that calls `loadStations()` and expects size > 400 (network).
- [ ] Step 2: Implement it with `fetch` and the Digitraffic-User header; on error, throw with a readable message.
- [ ] Step 3: Tests PASS, then commit.

### Task 3: App shell, map, KPIs, charts, panels

**Files:** Create `index.html`, `styles.css`, `src/app.js`

- KPI strip: trains analysed, % on time, mean final delay, delay-minutes created, est. €/day (with range).
- Map: sections drawn as lines coloured by α (delay created) and weighted by leverage; live trains as dots coloured by current delay, refreshed every 15 s; click a section → fingerprint card (α, β with CI, leverage, n, cause mix, intervention, Sweco service).
- Tabs: **Opportunities** (ranked by €/yr, evidence chips) · **Sections** (sortable table) · **Stations** (drill-down with train timetable vs actuals) · **Causes** (stacked bar by responsible party) · **What-if** (slider: reduce α on the selected section by X% → € saved/yr) · **History** (Task 5) · **Report** (Task 4) · **Assumptions** (editable, triggers recompute).
- Date range: 1–7 days ending yesterday (default 1 day, yesterday) plus the live overlay. Light and dark themes via tokens. Works at phone width.
- [ ] Step 1: Build it; verify in the preview: KPIs render real numbers, the map shows sections and trains, every tab renders, no console errors, and it works at 375 px.
- [ ] Step 2: Commit.

### Task 4: Report templates and AI reports

**Files:** Create `src/report.js`

**Produces:** `BUILTIN_TEMPLATES` (4: client-memo-vayla, exec-one-pager, tender-input, technical-note; fields `{id,name,audience,language,tone,sections[],instructions}`), `templateStore` (db collection `templates` with rules all read / interact write; fallback localStorage), `buildPrompt(template, summaryJSON) -> string`, `generateReport(template, analysis, onText)` via `sample` with streaming, `summarise(analysis) -> compact JSON` (top 10 sections, KPIs, causes, assumptions, CIs). The UI covers a template editor (create, duplicate, edit, delete, import/export JSON) and an "Ask the analyst" box.
- [ ] Step 1: Test in tests.html: buildPrompt includes every section heading and the language; summarise output is under 8,000 characters for a full-day analysis.
- [ ] Step 2: Implement; when sample is null, show the fallback message. Tests PASS. Commit.

### Task 5: Exports and fingerprint history

**Files:** Create `src/export.js`; modify `src/app.js`

**Produces:** `toCSV(rows) -> string`, `download(name, text|blob, mime)` (uses the `downloads` capability, else an anchor download), `exportGeoJSON`, `exportReportMarkdown`, `printReport()` (print stylesheet → PDF), `chartPNG(chart)`. History: "Save today's fingerprint" writes `history/{date}` = {sections: [{key, alpha, beta, leverage, infraShare, n}]} to db; the History tab charts α/β over saved dates for the selected section and flags a rising β.
- [ ] Step 1: Test toCSV escaping (comma, quote, newline). PASS.
- [ ] Step 2: Implement and verify downloads in the preview. Commit.

### Task 6: README, publish, git
- [ ] README.md: pitch, screenshots-free description, methods, data licence, how to run locally.
- [ ] Publish the artifact with `files` (src/*.js, styles.css) and capabilities `{sample:{}, db:{rules:[{path:"templates",read:"view",write:"interact"},{path:"history",read:"view",write:"interact"}]}, user:{}, downloads:true}`; check it in the browser; ArtifactData list of `templates`.
- [ ] Commit; ask the user before creating or pushing a GitHub repo.
