# Rail Delay Intelligence – Finland (design)

## Intent
A portfolio demo for Sweco's "Hybridingenjör – AI och järnväg" role. It should show that the candidate can
build AI tools for rail consultants, and that those tools turn into **billable consulting work** for Sweco in
Finland. Its audience is a Sweco railway group manager and colleagues, who will open a link.

The story it tells: *live open data → where the network loses time → what that costs in euros → which
infrastructure fix would pay back → an AI analyst that writes the client-ready memo.* Every step ends at a
service Sweco can sell to Väylävirasto (Finnish Transport Infrastructure Agency), Fintraffic or VR.

## Goals
- A live map of every train in Finland, coloured by delay (Digitraffic open API: free, no key).
- Delay analysis: punctuality by station and by line section, and **where delay is created** (the delay
  gained between consecutive stations) as opposed to where it is merely carried along.
- A **cost of delay** in €: passenger-hours lost × value of time, with freight shown separately. The
  assumptions are shown on screen and can be edited.
- A **"Sweco opportunity" panel**: the worst bottleneck sections ranked by € per year, each linked to a
  typical intervention (passing loop, double track, signalling/ERTMS, platform/dwell, timetable buffer)
  and the Sweco service that delivers it (feasibility study, design, capacity analysis).
- An **AI analyst** (Claude via the artifact's `sample` capability): ask questions about tonight's data, and
  click once for a short memo to a client, in English or Swedish.
- A what-if slider: cut the delay created on a section by X% and see € saved and the payback.

- **Modern layout**: a clean dashboard with a KPI strip, a large map, tabbed side panels and light and dark
  themes; works on a laptop and a phone.
- **Use the data well**: KPIs (trains running, % on time ≤3 min, average delay, delay-minutes created), the
  top sections by delay created, a station drill-down with each train's timetable versus actuals, and a
  delay distribution chart.
- **Exports**: CSV of sections, stations and trains; GeoJSON of current train positions; the report as
  Markdown, as HTML/print-to-PDF, and copied to the clipboard; a PNG snapshot of the charts.
- **Custom report templates**: built-in templates (Client memo – Väylävirasto, Executive one-pager, Tender
  input / anbudsunderlag, Technical note). Users can create, edit, duplicate and delete their own: name,
  audience, language, tone, sections (ordered list) and free-text instructions. Templates are shared with
  the team through the artifact's `db`, with a fallback to the browser if `db` is unavailable, and
  templates can be imported and exported as JSON.

## Scientific method (added)
Data: `/api/v1/trains/{date}` gives every train of a day with scheduled and actual times at every
timetable point, including passing points (~1,800 trains and ~67k actual times per day), and delay
**cause codes** (Digitraffic categories A–V, 47 detailed codes). Analysis covers 1–7 selected days, plus a
live overlay.

1. **Delay decomposition.** For each train, delay is measured to the second (actual − scheduled). For each
   run A→B: running-time delay gained = d_arr(B) − d_dep(A). For each stop: dwell delay gained =
   d_dep − d_arr. Totals split into *created* (positive gains, i.e. primary) and *recovered* (negative).
2. **Delay transfer function per section** (the novel part). Across all trains on a section, fit
   d_out = α + β·d_in with a **robust Theil–Sen estimator** (median of pairwise slopes, resistant to
   outliers). α is the delay the section creates on its own; β is the propagation coefficient (β<1 means
   the section absorbs delay because it has slack, β>1 means it amplifies delay, a capacity signature).
   Uncertainty comes from **bootstrap** resampling (200 resamples, 95% percentile CI).
3. **Empirical-Bayes shrinkage** of the mean delay created per section toward the network mean, weighted
   by sample size, so a section with 3 trains can't top the ranking by chance.
4. **Knock-on leverage**: for each section, the expected downstream delay-minutes per minute injected
   there, computed along each train's actual downstream route as Σ_k Π_j β_j (capped). This shows where
   one minute saved is worth most to the network.
5. **Cause attribution.** Cause codes are mapped to who can fix them: infrastructure (P1, S1–S2, T1–T3),
   track works (R1–R4), capacity and traffic management (L2, L3), and operator/rolling stock (K, V, J, M).
   The infrastructure and capacity shares are the addressable market for Sweco.
6. **Cost of delay with a CI**: passenger-hours lost × value of time, bootstrapped, so € figures are shown
   as a range, not a single point.

## Long-run customer value (added)
- A **Section Health Fingerprint** per section (α, β, leverage, infrastructure-cause share, n), saved each day
  to a shared history in the artifact `db` with one click. Over weeks this becomes a longitudinal baseline:
  trend charts flag sections whose fingerprint is deteriorating (β rising, infrastructure causes rising).
  That's an early-warning signal for asset management and investment planning, and the basis for a
  recurring Sweco analytics service (monthly network health report) rather than a one-off study.
- Every opportunity names its evidence (α, β, CI, causes), so it can go straight into a feasibility study scope.

## Delivery (added)
- A git repository with `index.html` (the app), `README.md` (what it does, methods, data licence: Digitraffic
  / Fintraffic, CC BY 4.0) and this design. Commits are local; pushing to GitHub happens only after the
  user confirms the repository name and visibility.

## Non-goals
- Not a real timetable or capacity simulation (no RailSys/OpenTrack-grade modelling).
- No Swedish data in v1 (Trafikverket needs a key). The data layer stays swappable.
- No back end and no login.

## Anti-goals
- Numbers that look authoritative but aren't: every € figure must show its assumptions and be labelled
  an estimate.
- A pretty map with no consulting angle.
- Breaking when Claude or the API is unavailable: the page must still work without the AI panel.

## Approaches considered
- **A. Live network + AI analyst on Finnish data (chosen)**: live, no key, and covers three tasks from the
  ad (data analysis, expert assistant, report writing).
- B. The same on Trafikverket data: needs a key; possible later as a data-source switch.
- C. Line design assistant: closest to CAD, but uses little movement data and is hard to make convincing.

## How
- A single-page HTML artifact published on claude.ai, using Leaflet (cdnjs) with CARTO/OSM tiles.
- Data: `rata.digitraffic.fi/api/v1` – `train-locations.geojson/latest` (polled every 15 s),
  `live-trains?arrived_trains=…` / `trains/{date}` for timetable rows with `differenceInMinutes`, and
  `metadata/stations` for station names and coordinates.
- Analysis runs in the browser: for each train, compare the delay at consecutive stations to get the delay
  gained per section, then aggregate by section and station.
- The AI panel sends a compact JSON summary (top sections, KPIs, assumptions) to `sample`. If the
  capability is missing, the panel is hidden.
- Fallback: if the artifact sandbox blocks the API, the same file runs locally in a browser.

## Builder's calls (mine, open to change)
- Default value of time is €15 per passenger-hour; default load is 250 passengers per long-distance train,
  150 per commuter train and 0 for freight. Freight is costed at €2 per train-minute. All are editable.
- Annualisation: tonight's sample × 365, clearly labelled as an extrapolation.
- Visual style: dark operations-room look; the UI is in English with a Swedish memo option.
