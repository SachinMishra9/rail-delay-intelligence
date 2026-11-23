// Report templates, AI prompt construction and template storage.
import { classifyCause, costOf, sectionCost } from './analysis.js';

export const BUILTIN_TEMPLATES = [
  {
    id: 'client-memo-vayla', builtin: true, name: 'Client memo – Väylävirasto',
    audience: 'Finnish Transport Infrastructure Agency (Väylävirasto) programme managers',
    language: 'English', tone: 'Professional, evidence-led, concise',
    sections: ['Summary', 'Where the network loses time', 'Cost of delay (estimate)', 'Recommended interventions', 'Proposed next step with Sweco'],
    instructions: 'Ground every claim in the data provided. Quote α, β and confidence intervals where useful. End with a concrete, scoped study proposal.',
  },
  {
    id: 'exec-one-pager', builtin: true, name: 'Executive one-pager',
    audience: 'Non-technical executives', language: 'English', tone: 'Plain, decisive, no jargon',
    sections: ['The headline', 'Three numbers that matter', 'What we recommend', 'Why now'],
    instructions: 'Maximum 250 words. Translate statistics into plain consequences (minutes, euros, passengers).',
  },
  {
    id: 'tender-input', builtin: true, name: 'Tender input / anbudsunderlag',
    audience: 'Sweco bid team preparing a proposal', language: 'Swedish', tone: 'Saklig och säljande',
    sections: ['Kundens utmaning', 'Vår analys av nuläget', 'Föreslagna insatser', 'Sweco erbjudande och leverabler', 'Risker och antaganden'],
    instructions: 'Write in Swedish. Frame findings as the customer problem and Sweco services (kapacitetsutredning, förstudie, projektering, signalteknik) as the solution.',
  },
  {
    id: 'technical-note', builtin: true, name: 'Technical note',
    audience: 'Rail capacity and signalling engineers', language: 'English', tone: 'Technical and precise',
    sections: ['Data and method', 'Results by section', 'Delay propagation (β) interpretation', 'Limitations', 'Further analysis'],
    instructions: 'Explain the Theil–Sen transfer function, bootstrap CIs and empirical-Bayes shrinkage briefly. Be explicit about limitations of open data.',
  },
];

/** Map a section fingerprint to a typical intervention and the Sweco service that delivers it. */
export function interventionFor(s) {
  const mix = s.causeMix || {};
  const top = Object.entries(mix).sort((a, b) => b[1] - a[1])[0]?.[0];
  if ((s.beta != null && s.beta > 1.05) || top === 'capacity')
    return { fix: 'Passing loop or double-track section', service: 'Capacity study & track design', why: 'Delay is amplified (β>1) or capacity conflicts dominate' };
  if (top === 'infrastructure')
    return { fix: 'Asset renewal / predictive maintenance', service: 'Asset management & renewal design', why: 'Infrastructure faults dominate causes' };
  if (top === 'works')
    return { fix: 'Possession & works-phase traffic planning', service: 'Construction-phase traffic planning', why: 'Track works drive the delay' };
  if (top === 'operator')
    return { fix: 'Platform / dwell-time redesign', service: 'Station & platform design', why: 'Dwell and operations causes dominate' };
  if (s.beta != null && s.beta < 0.6)
    return { fix: 'Timetable buffer re-allocation', service: 'Timetable robustness analysis', why: 'Section absorbs delay (β<1): slack could be used elsewhere' };
  return { fix: 'Signalling upgrade (ERTMS headway study)', service: 'Signalling & ERTMS consulting', why: 'Delay created locally without a dominant cause' };
}

const r1 = x => x == null || !Number.isFinite(x) ? undefined : Math.round(x * 10) / 10;
const r2 = x => x == null || !Number.isFinite(x) ? undefined : Math.round(x * 100) / 100;

/** Rank sections by € per day, the opportunity list the UI and AI share. */
export function rankOpportunities(analysis, assumptions, limit = 15) {
  const days = analysis.kpis.days || 1;
  return [...analysis.sections.values()]
    .map(s => ({ s, eurPerDay: sectionCost(s, assumptions) / days }))
    .filter(o => o.eurPerDay > 0)
    .sort((a, b) => b.eurPerDay - a.eurPerDay)
    .slice(0, limit);
}

/** Compact, number-rounded JSON summary of an analysis for the AI (kept < 8k chars). */
export function summarise(analysis, stations, assumptions = analysis.assumptions) {
  const name = c => stations.get(c)?.name || c;
  const cost = costOf(analysis, assumptions);
  const days = analysis.kpis.days || 1;
  const k = analysis.kpis;
  return {
    source: 'Fintraffic / digitraffic.fi open data (CC BY 4.0)',
    kpis: { trains: k.trains, days: k.days, onTimePct: r1(k.onTimePct), meanFinalDelayMin: r2(k.meanFinalDelayMin),
      p90FinalDelayMin: r2(k.p90FinalDelayMin), delayCreatedMin: Math.round(k.createdMin || 0),
      createdRunMin: Math.round(k.createdRunMin || 0), createdDwellMin: Math.round(k.createdDwellMin || 0) },
    costPerDayEUR: { estimate: Math.round(cost.eur / days), lo95: Math.round(cost.lo / days), hi95: Math.round(cost.hi / days) },
    assumptions,
    causeShares: analysis.causes.byBucket,
    topSections: rankOpportunities(analysis, assumptions, 10).map(({ s, eurPerDay }) => {
      const iv = interventionFor(s);
      return { section: `${name(s.from)} → ${name(s.to)}`, trains: s.n, delayCreatedMin: Math.round(s.created / 60),
        alphaSec: r1(s.alpha), beta: r2(s.beta), betaCI95: s.betaCI ? [r2(s.betaCI.lo), r2(s.betaCI.hi)] : undefined,
        leverage: r2(s.leverage), eurPerDay: Math.round(eurPerDay), causes: s.causeMix, suggestedFix: iv.fix, swecoService: iv.service };
    }),
    method: 'Delay decomposition per run; robust Theil–Sen d_out=α+β·d_in per section; bootstrap 95% CI (B=200); empirical-Bayes shrinkage; knock-on leverage Σ∏β (cap 3).',
  };
}

/** Prompt for one report from a template. */
export function buildPrompt(template, summary) {
  return [
    'You are a senior railway consultant at Sweco writing for a client in Finland.',
    `Audience: ${template.audience}`,
    `Language: write the whole report in ${template.language}.`,
    `Tone: ${template.tone}`,
    `Use exactly these Markdown sections (## headings), in order:\n${template.sections.map(s => `- ${s}`).join('\n')}`,
    `Additional instructions: ${template.instructions}`,
    'Rules: use only the data below; label all euro figures as estimates and give the 95% range; never invent stations or numbers; output Markdown only.',
    'DATA (JSON):',
    JSON.stringify(summary),
  ].join('\n\n');
}

/** Prompt for a free-form analyst question. */
export function buildQuestionPrompt(question, summary) {
  return `You are a railway delay analyst. Answer the question using only this data, briefly (max 150 words), citing numbers. If the data cannot answer it, say so.\n\nQUESTION: ${question}\n\nDATA (JSON): ${JSON.stringify(summary)}`;
}

// ---------- template storage: shared db when available, else localStorage ----------
const LS_KEY = 'rdi.templates';
const claudeUse = name => (typeof window !== 'undefined' && window.claude?.use) ? window.claude.use(name).catch(() => null) : Promise.resolve(null);

export async function createTemplateStore() {
  const db = await claudeUse('db');
  if (db) {
    const col = db.collection('templates');
    return {
      shared: true,
      async list() { const snap = await col.get(); return snap.docs.map(d => ({ id: d.id, ...d.data() })); },
      async save(t) { const { id, ...rest } = t; await col.doc(id).set(rest); },
      async remove(id) { await col.doc(id).delete(); },
    };
  }
  const read = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
  const write = list => { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage blocked */ } };
  return {
    shared: false,
    async list() { return read(); },
    async save(t) { const l = read().filter(x => x.id !== t.id); l.push(t); write(l); },
    async remove(id) { write(read().filter(x => x.id !== id)); },
  };
}

/** Claude via the artifact `sample` capability; null when unavailable (e.g. running locally). */
export const getSampler = () => claudeUse('sample');

export { classifyCause };
