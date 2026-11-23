// Export helpers: CSV, GeoJSON, Markdown, print-to-PDF, PNG.
export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}

let downloadsCap;
async function downloadsApi() {
  if (downloadsCap === undefined) {
    downloadsCap = (typeof window !== 'undefined' && window.claude?.use) ? await window.claude.use('downloads').catch(() => null) : null;
  }
  return downloadsCap;
}

/** Offer a file to the viewer: artifact `downloads` capability, else a normal anchor download. */
export async function download(filename, data, mime = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const api = await downloadsApi();
  if (api) {
    try { await api.save({ filename, data: blob }); return; }
    catch (e) { if (e?.code === 'declined' || e?.code === 'not_granted') return; /* else fall back */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function chartPNG(chart, filename) {
  return fetch(chart.toBase64Image('image/png', 1)).then(r => r.blob()).then(b => download(filename, b, 'image/png'));
}

/** Minimal, safe Markdown → HTML (headings, bold, lists, paragraphs). Input is escaped first. */
export function mdToHtml(md) {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  const out = []; let list = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.*)/), li = line.match(/^\s*[-*]\s+(.*)/), ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (!li && !ol && list) { out.push(`</${list}>`); list = null; }
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (li || ol) { const t = li ? 'ul' : 'ol'; if (list !== t) { if (list) out.push(`</${list}>`); out.push(`<${t}>`); list = t; } out.push(`<li>${inline((li || ol)[1])}</li>`); }
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('\n');
}

/** Standalone HTML document for a report (download or print-to-PDF). */
export function reportHTML(title, md) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>
<style>body{font:15px/1.6 Inter,system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#14161a}
h1{font-size:24px;margin-bottom:4px}h2,h3{margin-top:28px}.meta{color:#666;font-size:13px}
footer{margin-top:40px;color:#888;font-size:12px;border-top:1px solid #ddd;padding-top:8px}</style></head>
<body><h1>${title.replace(/</g, '&lt;')}</h1><div class="meta">Generated ${new Date().toISOString().slice(0, 10)} · Rail Delay Intelligence</div>
${mdToHtml(md)}<footer>Data: Fintraffic / digitraffic.fi, CC BY 4.0. Euro figures are estimates.</footer></body></html>`;
}

export function printReport(title, md) {
  const w = window.open('', '_blank');
  if (!w) { download(`${title}.html`, reportHTML(title, md), 'text/html'); return; }
  w.document.write(reportHTML(title, md)); w.document.close(); w.focus();
  setTimeout(() => w.print(), 300);
}
