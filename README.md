# Rail Delay Intelligence – Finland

A demo of AI-assisted railway engineering. It turns Finland's open train data into **where the network loses time, what that costs, and which intervention would pay back**, then has Claude write the client-ready report.

Built as a portfolio piece for Sweco's *Hybridingenjör – AI och järnväg* role.

## What it does

| | |
|---|---|
| **Live map** | Every train in Finland (GPS positions every 15 s), coloured by current delay; sections coloured by delay created and sized by € impact. |
| **Opportunities** | Line sections ranked by the estimated cost of the delay they *create*, each with its statistical evidence and the intervention and Sweco service its fingerprint points to. |
| **Section health fingerprint** | α (delay created on its own), β (does the section absorb or amplify incoming delay?), knock-on leverage, cause mix, and a scatter of delay in vs delay out with the robust fit. |
| **Causes** | Official Fintraffic delay cause codes, grouped by who can fix them (infrastructure, track works, capacity, operator). |
| **What-if** | Remove X% of a section's delay → € saved per year, network knock-on, payback and a rough benefit–cost ratio. |
| **History** | Save each period's fingerprints to a shared database to build a long-run baseline and flag sections that are getting worse. |
| **AI analyst** | Ask questions, or generate reports from templates (client memo for Väylävirasto, executive one-pager, Swedish tender input, technical note). You can also create, edit, import and export your own templates. |
| **Exports** | CSV (opportunities, sections, stations, causes, history), PNG charts, and reports as Markdown, HTML, print-to-PDF or clipboard. |

## Method

1. **Delay decomposition.** For each train, delay is measured to the second (`actualTime − scheduledTime`) at every timetable point. Running-time gain is d_arr(B) − d_dep(A) and dwell gain is d_dep − d_arr.
2. **Delay transfer function per section.** d_out = α + β·d_in is fitted with the **Theil–Sen** estimator (median of pairwise slopes, robust to outliers). β < 1 means the section absorbs delay and β > 1 means it amplifies it (a capacity signature).
3. **Bootstrap** 95% confidence intervals (B = 200) for β and for every cost figure.
4. **Empirical-Bayes shrinkage** of the mean delay created per run, `(n·m + k·g)/(n + k)` with k = median n, so a section with only a few trains can't top the ranking by chance.
5. **Knock-on leverage**: the mean over trains of Σₖ Πⱼ βⱼ along each train's downstream route (β clipped to [0, 1.5], capped at 3).
6. **Cost of delay** = passenger-hours × value of time, plus freight minutes × €/min. All assumptions are on screen and editable.

Every € figure is an **estimate**. For client work, replace the defaults with Väylävirasto unit values and observed occupancy.

## Run locally

```bash
python3 -m http.server 8771
```

Then open http://localhost:8771. Live data, maps, analysis and exports work locally. The AI analyst and shared history/templates need the published claude.ai page, where Claude and the shared database are available.

Tests (pure maths, headless with macOS JavaScriptCore, or open `tests/tests.html` in a browser):

```bash
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs
```

## Structure

```
index.html, styles.css   UI shell and theme (light and dark)
src/analysis.js          statistics: decomposition, Theil–Sen, bootstrap, shrinkage, leverage, cost
src/data.js              digitraffic.fi API client
src/worker.js            runs the analysis off the main thread
src/report.js            templates, interventions, AI prompt and summary
src/export.js            CSV, downloads, Markdown → HTML, print
src/app.js               map, KPIs, tabs
tests/                   jsc and browser test harness
docs/superpowers/        design spec and implementation plan
```

## Data & licence

Train data: **Fintraffic / digitraffic.fi**, CC BY 4.0. Map: © OpenStreetMap contributors.
