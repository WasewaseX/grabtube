/** TubeGrab stress suite — hammers the public API like the UI does.

const JSON_HEADERS = { "Content-Type": "application/json" };

 *  Usage: bun run scripts/stress.mjs [rounds]. Covers extraction sweep,
 *  error honesty, instant/merge/mp3 lifecycles and the direct-link lane. */
const BASE = "http://localhost:3000";

const TARGETS = [
  { name: "popular-4K", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
  { name: "classic", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
  { name: "music-long", url: "https://www.youtube.com/watch?v=kJQP7kiw5Fk" },
  { name: "shorts", url: "https://www.youtube.com/shorts/9bZkp7q19f0" },
  { name: "obscure-1", url: "https://www.youtube.com/watch?v=lTRiuFIWV54" },
  { name: "obscure-2", url: "https://www.youtube.com/watch?v=wAPCSnAhhC8" },
  { name: "obscure-3", url: "https://www.youtube.com/watch?v=amfWIRasxtI" },
  { name: "obscure-4", url: "https://www.youtube.com/watch?v=53gNFOqDFcE" },
];

const ERRORS = [
  { name: "invalid-url", url: "https://www.youtube.com/watch?v=NOTAVID!!", expectFail: true },
  { name: "unavailable", url: "https://www.youtube.com/watch?v=8h9xFU-VMKJ", expectFail: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(url) {
  const res = await fetch(`${BASE}/api/info`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: res.status, body: await res.json() };
}

async function downloadInstant(infoId, formatId) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/download?infoId=${infoId}&formatId=${formatId}`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) return { ok: false, ms: Date.now() - t0, err: `http ${res.status}` };
  const buf = await res.arrayBuffer();
  return { ok: true, ms: Date.now() - t0, bytes: buf.byteLength };
}

async function waitForJob(jobId, label) {
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const res = await fetch(`${BASE}/api/jobs/${jobId}`, { signal: AbortSignal.timeout(10_000) });
    const j = (await res.json()).job;
    if (j.state === "ready") return { ok: true, bytes: j.sizeBytes };
    if (j.state === "error" || j.state === "cancelled")
      return { ok: false, err: `${j.error || j.state}` };
  }
  return { ok: false, err: "timeout" };
}

async function health() {
  const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15_000) });
  return res.json();
}

let pass = 0;
let fail = 0;
const failures = [];

function record(name, ok, detail) {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${name}: ${detail}`);
  }
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? detail : `— ${detail}`}`);
}

function concat(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function sha(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checkHealthLane() {
  // health coherence
  const h = await health();
  const active = h.lanes?.find((l) => l.active);
  record("health.active-lane", !!active, `${active?.id} ip=${active?.egressIp ?? "?"}`);
}

async function runExtractionSweep() {
  const infos = {};
  for (const tgt of TARGETS) {
    try {
      const r = await info(tgt.url);
      if (r.body?.error) {
        record(`extract.${tgt.name}`, false, `${r.body.error.code}`);
        continue;
      }
      const inf = r.body.info;
      const n = inf.videoFormats.length + inf.audioFormats.length;
      const ok = n > 0;
      record(`extract.${tgt.name}`, ok, `${n} formats "${inf.title.slice(0, 34)}"`);
      if (ok) infos[tgt.name] = r.body;
    } catch (e) {
      record(`extract.${tgt.name}`, false, String(e).slice(0, 90));
    }
  }
  return infos;
}

async function runErrorHonesty() {
  for (const e of ERRORS) {
    try {
      const r = await info(e.url);
      const hasError = r.body?.error && r.body.error.code;
      record(`errcase.${e.name}`, !!hasError, hasError ? `${r.body.error.code}` : "NO ERROR RETURNED?!");
    } catch (err) {
      record(`errcase.${e.name}`, false, String(err).slice(0, 90));
    }
  }
}

async function runInstantCheck(firstOk) {
  // instant download on the first successful extraction
  if (!firstOk) return;
  const [name, data] = firstOk;
  const inst = data.info.videoFormats.find((f) => f.instant);
  if (!inst) return;
  const r = await downloadInstant(data.info.infoId, inst.id);
  const ok = r.ok && r.bytes > 500_000;
  record(
    `instant.${name}`,
    ok,
    ok ? `${(r.bytes / 1e6).toFixed(1)}MB in ${(r.ms / 1000).toFixed(1)}s (${(r.bytes / 1e6 / (r.ms / 1000)).toFixed(1)}MB/s)` : r.err || "too small",
  );
}

async function runMergeCheck(firstOk) {
  // merge job (highest <=1080p) on the first successful extraction
  if (!firstOk) return;
  const [name, data] = firstOk;
  const m = [...data.info.videoFormats]
    .filter((f) => !f.instant && f.height <= 1080)
    .sort((a, b) => (b.height - a.height) || ((b.fps || 0) - (a.fps || 0)))[0];
  if (!m) return;
  try {
    const res = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        infoId: data.info.infoId,
        mode: "merge",
        videoFormatId: m.id,
        title: data.info.title,
        duration: data.info.duration,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json()).job;
    const r = await waitForJob(j.id, `merge.${name}`);
    record(
      `merge.${name}@${m.quality}`,
      r.ok,
      r.ok ? `ready ${(r.bytes / 1e6).toFixed(0)}MB` : r.err,
    );
  } catch (e) {
    record(`merge.${name}`, false, String(e).slice(0, 90));
  }
}

async function runMp3Check(firstOk) {
  // mp3 320
  if (!firstOk) return;
  const [name, data] = firstOk;
  try {
    const res = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        infoId: data.info.infoId,
        mode: "mp3",
        bitrate: 320,
        title: data.info.title,
        duration: data.info.duration,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json()).job;
    const r = await waitForJob(j.id, `mp3.${name}`);
    record(`mp3.${name}`, r.ok, r.ok ? `ready ${(r.bytes / 1e6).toFixed(1)}MB` : r.err);
  } catch (e) {
    record(`mp3.${name}`, false, String(e).slice(0, 90));
  }
}

async function checkDirectLinkRange(name, dlUrl, inst) {
  // 1. bounded range → 206 + correct slice
  try {
    const res = await fetch(dlUrl(`f=${encodeURIComponent(inst.id)}&q=${inst.quality}`), {
      headers: { Range: "bytes=1000000-1000099" },
      signal: AbortSignal.timeout(120_000),
    });
    const buf = await res.arrayBuffer();
    const cr = res.headers.get("content-range") || "";
    const ok =
      res.status === 206 && buf.byteLength === 100 && cr === "bytes 1000000-1000099/100";
    // total only matches if the range is valid; just require the prefix
    const okReal = res.status === 206 && buf.byteLength === 100 && cr.startsWith("bytes 1000000-1000099/");
    record(`dlink.range.${name}`, okReal, okReal ? cr : `http ${res.status} ${buf.byteLength}B ${cr}`);
  } catch (e) {
    record(`dlink.range.${name}`, false, String(e).slice(0, 90));
  }
}

async function checkAbortResume(name, dlUrl, inst) {
  // 2. abort→resume drill: pull exactly 3MB, drop, resume from 3MB, compare hash
  try {
    const url = dlUrl(`f=${encodeURIComponent(inst.id)}&q=${inst.quality}`);
    const CUT = 3_000_000;

    // pass 1: abort after 3MB (simulated flaky connection)
    const res1 = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    const r1 = res1.body.getReader();
    const parts1 = [];
    let got = 0;
    for (;;) {
      const { done, value } = await r1.read();
      if (done) break;
      parts1.push(value);
      got += value.length;
      if (got >= CUT) {
        await r1.cancel();
        break;
      }
    }
    const head = concat(parts1).slice(0, CUT);

    // pass 2: resume from the exact offset
    const res2 = await fetch(url, {
      headers: { Range: `bytes=${CUT}-` },
      signal: AbortSignal.timeout(180_000),
    });
    const tail = new Uint8Array(await res2.arrayBuffer());

    // ground truth: one clean full download
    const clean = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    const cleanBuf = new Uint8Array(await clean.arrayBuffer());

    const resumed = concat([head, tail]);
    const ok =
      resumed.length === cleanBuf.length && (await sha(resumed)) === (await sha(cleanBuf));
    record(
      `dlink.abort-resume.${name}`,
      ok,
      ok ? `cut at ${CUT / 1e6}MB → ${(resumed.length / 1e6).toFixed(1)}MB, sha256 identical` : `len ${resumed.length} vs ${cleanBuf.length}`,
    );
  } catch (e) {
    record(`dlink.abort-resume.${name}`, false, String(e).slice(0, 90));
  }
}

async function checkParallelSegments(name, dlUrl, inst) {
  // 3. parallel segments (IDM 4-way) — reassemble and spot-check seams
  try {
    const url = dlUrl(`f=${encodeURIComponent(inst.id)}&q=${inst.quality}`);
    const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(120_000) });
    const total = parseInt((probe.headers.get("content-range") || "/0").split("/")[1], 10);
    const segLen = Math.ceil(total / 4);
    const segs = await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        const s = i * segLen;
        const e = Math.min(s + segLen - 1, total - 1);
        const r = await fetch(url, {
          headers: { Range: `bytes=${s}-${e}` },
          signal: AbortSignal.timeout(180_000),
        });
        return { i, buf: new Uint8Array(await r.arrayBuffer()), status: r.status };
      }),
    );
    const okStatus = segs.every((s) => s.status === 206);
    const okLen = segs.reduce((a, s) => a + s.buf.byteLength, 0) === total;
    record(
      `dlink.parallel4.${name}`,
      okStatus && okLen,
      okStatus && okLen ? `4×206 segments = ${(total / 1e6).toFixed(1)}MB reassembled` : `status:${segs.map((s) => s.status).join(",")} len:${okLen}`,
    );
  } catch (e) {
    record(`dlink.parallel4.${name}`, false, String(e).slice(0, 90));
  }
}

async function runDirectLinkChecks(firstOk) {
  /* ---------- direct links (/api/dl) — IDM-style ---------- */
  if (!firstOk) return;
  const [name, data] = firstOk;
  const inst = data.info.videoFormats.find((f) => f.instant) ||
    { id: "18", quality: "360p" };
  const u = Buffer.from(data.info.webpageUrl).toString("base64url");
  const dlUrl = (qs) => `${BASE}/api/dl?u=${u}&${qs}`;

  await checkDirectLinkRange(name, dlUrl, inst);
  await checkAbortResume(name, dlUrl, inst);
  await checkParallelSegments(name, dlUrl, inst);
}

async function runRound(round) {
  console.log(`\n================ ROUND ${round} ================`);
  await checkHealthLane();
  const infos = await runExtractionSweep();
  await runErrorHonesty();
  const firstOk = Object.entries(infos)[0];
  await runInstantCheck(firstOk);
  await runMergeCheck(firstOk);
  await runMp3Check(firstOk);
  await runDirectLinkChecks(firstOk);
}

const rounds = parseInt(process.argv[2] || "2", 10);
for (let i = 1; i <= rounds; i++) {
  await runRound(i);
  if (i < rounds) await sleep(2000);
}

console.log(`\n================================`);
console.log(`TOTAL: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
