// diagnose-blank.mjs — 面板纯白时的一次性诊断：读页面送回的上报 + 看服务器发出的 bundle 内容。
const B = 'http://127.0.0.1:3080'
const api = B + '/mi-remote/api'
const out = { step: 'start' }

try {
  const j = await fetch(api + '/diag', { signal: AbortSignal.timeout(20000) }).then((r) => r.json())
  out.diagPresent = j.diag !== null && j.diag !== undefined
  out.diagKind = j.diag && j.diag.kind ? j.diag.kind : null
  const list = j.diagnostics || []
  out.eventCount = list.length
  out.events = list.slice(-12).map((d) => ({
    at: new Date(d.at).toLocaleTimeString('zh-CN'),
    kind: d.kind,
    detail: JSON.stringify(Object.fromEntries(
      Object.entries(d).filter(([k]) => k !== 'at' && k !== 'kind' && k !== 'stack'),
    )).slice(0, 160),
    stackHead: d.stack ? String(d.stack).split('\n').slice(0, 3).join(' | ').slice(0, 300) : null,
  }))
} catch (e) {
  out.diagError = String(e && e.message)
}

try {
  const html = await fetch(B + '/', { signal: AbortSignal.timeout(30000) }).then((r) => r.text())
  const at = html.indexOf('__DSH_BOOT__')
  out.htmlBytes = html.length
  out.hasBoot = at >= 0
  const urls = [...html.slice(at).matchAll(/"([^"]*plugins\/\?\?[^"]+)"/g)].map((m) => m[1])
  out.bundleCount = urls.length
  out.bundles = []
  for (const u of urls.slice(0, 6)) {
    const t = await fetch(B + '/' + u, { signal: AbortSignal.timeout(40000) }).then((r) => r.text())
    out.bundles.push({
      url: u.slice(0, 46),
      bytes: t.length,
      hasMine: t.includes('dsh-mi-remote'),
      hasPanel: t.includes('data-dsmr-panel'),
      hasReport: t.includes('panel-mounted'),
    })
  }
} catch (e) {
  out.bundleError = String(e && e.message)
}

out.step = 'done'
console.log(JSON.stringify(out, null, 1))
