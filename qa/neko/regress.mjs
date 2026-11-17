// 네코 엔진 회귀 검사: Vite 개발 서버를 띄우고 qa/neko/harness.html 에서 엔진을 돌려 기준을 확인한다.
//   npm run qa:neko            (Playwright 와 Chromium 이 필요: npx playwright install chromium)
//   CHROMIUM_PATH=... npm run qa:neko   (따로 깔린 Chromium 을 쓸 때)
// 기준은 docs/neko-v26-integration.md §11.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const exe = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const results = [];
const check = (name, value, ok, note = "") => { results.push({ name, value, ok, note }); };
const errors = [];

async function open(query = "", viewport = { width: 760, height: 1000 }, dpr = 1) {
  const p = await browser.newPage({ viewport, deviceScaleFactor: dpr });
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await p.goto(`${base}/qa/neko/harness.html${query}`);
  await p.waitForFunction(() => window.__nekoReady === true);
  await p.click("#wander"); // 산책 끔(결정적으로)
  await p.waitForTimeout(200);
  return p;
}
const pick = (p, id) => p.click(`label:has(#${id})`);
const ACTS = ["draw", "music", "butterfly", "snack", "stretch", "typing", "reading", "stamp", "groom", "knead", "yarn", "box", "window", "climb"];

try {
  // 1) 활동 14개를 12초씩 + 빠르게 바꾸기 + 밖에서 활동 더하기: 값이 깨지지 않는가
  {
    const p = await open();
    const r = await p.evaluate((ACTS) => {
      const n = window.__neko, c = n.cat, bad = [];
      const ok = () => [c.x, c.y, c.head.x, c.head.y, ...c.tail.map((t) => t.x)].every(Number.isFinite);
      for (const k of ACTS) { n.act(k); for (let s = 0; s < 120 * 12; s++) { n.step(1); if (s % 6 === 0) n.draw(); if (!ok()) { bad.push(k); break; } } n.act(null); n.step(240); }
      for (let r = 0; r < 60; r++) { n.act(ACTS[Math.floor(Math.random() * ACTS.length)]); n.step(Math.floor(Math.random() * 40)); n.draw(); }
      n.act(null); n.step(600);
      n.defineActivity("wave", { name: "손 흔들기", label: "손 흔드는 중", pose: (A, ramp) => ({ sit: true, expr: "happy", feetW: ramp, feet: { 3: (L, h) => [h[0] + c.face * 14 * n.S, h[1] - 26 * n.S] } }) });
      n.act("wave"); n.step(240); n.draw();
      return { bad, finite: ok(), act: n.activity };
    }, ACTS);
    check("활동 14개·빠른 전환·외부 활동: 값 유한", r.bad.length ? r.bad.join(",") : "모두 정상", r.bad.length === 0 && r.finite && r.act === "wave");
    await p.close();
  }

  // 2) 이음매: 배경 없이 그려 실루엣을 1.5px 깎고 조각 수(1 이어야)
  {
    const p = await open("?transparent=1", { width: 760, height: 1000 }, 2);
    await p.evaluate(() => {
      window.__pieces = () => {
        const cv = document.getElementById("stage"), w = cv.width, h = cv.height, d = cv.getContext("2d").getImageData(0, 0, w, h).data;
        let m = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
        for (let pass = 0; pass < 3; pass++) { const nn = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; nn[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w]; } m = nn; }
        const seen = new Uint8Array(w * h), st = []; let pieces = 0;
        for (let s = 0; s < w * h; s++) { if (!m[s] || seen[s]) continue; let area = 0; st.push(s); seen[s] = 1; while (st.length) { const i = st.pop(); area++; for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < w * h && m[j] && !seen[j]) { seen[j] = 1; st.push(j); } } if (area > 40) pieces++; }
        return pieces;
      };
    });
    const box = await p.locator("#stage").boundingBox();
    const samples = [];
    const sample = async () => samples.push(await p.evaluate(() => { window.__neko.draw(); return window.__pieces(); }));
    const h = await p.evaluate(() => ({ x: window.__neko.cat.head.x, y: window.__neko.cat.head.y }));
    await p.mouse.move(box.x + h.x, box.y + h.y); await p.mouse.down();
    for (let i = 1; i <= 10; i++) { await p.mouse.move(box.x + h.x, box.y + h.y - i * 14); await p.waitForTimeout(16); }
    for (let k = 0; k < 30; k++) { const t = k * 0.35; await p.mouse.move(box.x + h.x + Math.sin(t) * 150, box.y + h.y - 140 + Math.cos(t * 1.7) * 40); await p.waitForTimeout(40); await sample(); }
    await p.mouse.up();
    for (let k = 0; k < 25; k++) { await p.waitForTimeout(35); await sample(); }
    for (const pose of ["sit", "loaf", "lie", "stand"]) { await pick(p, `pose-${pose}`); for (let k = 0; k < 8; k++) { await p.waitForTimeout(60); await sample(); } }
    for (let r = 0; r < 2; r++) { await p.click("#jump"); for (let k = 0; k < 12; k++) { await p.waitForTimeout(40); await sample(); } }
    const bad = samples.filter((n) => n !== 1).length;
    check("이음매: 실루엣 조각 1개", `${samples.length}장 중 ${bad}장 어긋남`, bad === 0);
    await p.close();
  }

  // 3) 식빵: 다리가 몸 밖으로(단위) ≤ 1
  {
    const p = await open();
    let worst = 0;
    for (const bd of ["slim", "normal", "chubby"]) for (const ll of ["short", "normal", "long"]) {
      await pick(p, `build-${bd}`); await pick(p, `legs-${ll}`); await pick(p, "pose-stand"); await p.evaluate(() => window.__neko.step(200)); await pick(p, "pose-loaf");
      worst = Math.max(worst, await p.evaluate(() => {
        const n = window.__neko, c = n.cat, S = n.S; n.step(500); const poly = n.debug.bodyWorld();
        const inside = (x, y) => { let k = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) k = !k; } return k; };
        const dist = (x, y) => { let m = 1e9; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ax, ay] = poly[j], [bx, by] = poly[i]; const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy))); m = Math.min(m, Math.hypot(x - ax - vx * t, y - ay - vy * t)); } return m; };
        let w = 0;
        for (const L of c.legs) for (const [x, y, rr] of n.debug.legSamples(L).concat([[L.footW[0] + c.face * 1.6 * S, L.footW[1], 7 * S * (1 - 0.35 * (L.fold || 0))]]))
          for (let a = 0; a < 6.28; a += 0.5) { const qx = x + Math.cos(a) * rr, qy = y + Math.sin(a) * rr; if (!inside(qx, qy)) w = Math.max(w, dist(qx, qy) / S); }
        return w;
      }));
    }
    check("식빵: 다리가 몸 밖으로", `${worst.toFixed(2)} 단위`, worst <= 1);
    await pick(p, "pose-stand"); await pick(p, "build-normal"); await pick(p, "legs-normal");

    // 4) 상자: 옆·바닥 밑·몸통 위로 튀어나옴 = 0
    let side = 0, below = 0;
    for (const bd of ["slim", "chubby"]) for (const fur of ["short", "long"]) {
      await pick(p, `build-${bd}`); await pick(p, `fur-${fur}`);
      const r = await p.evaluate(() => {
        const n = window.__neko, c = n.cat, S = n.S, F = n.floorY; n.act(null); n.step(600); n.act("box");
        let side = 0, below = 0;
        for (let k = 0; k < 120 * 20; k++) {
          n.step(1); const A = c.act; if (!A || A.t < 1.2 || A.pt < 0.5) continue;
          const bx = A.box, x0 = bx.x - bx.w / 2, x1 = bx.x + bx.w / 2, rim = F - bx.h;
          for (const [x, y] of [...c.jig.map((j) => [j.gx + j.ox, j.gy + j.oy]), ...c.legs.flatMap((L) => [L.knee, L.footW, L.hipW])]) { if (y > rim) side = Math.max(side, (x0 - x) / S, (x - x1) / S); below = Math.max(below, (y - F) / S); }
        }
        n.act(null); return { side, below };
      });
      side = Math.max(side, r.side); below = Math.max(below, r.below);
    }
    check("상자: 옆으로 튀어나옴", `${side.toFixed(2)} 단위`, side <= 0.05);
    check("상자: 바닥 밑으로", `${below.toFixed(2)} 단위`, below <= 0.05);
    await pick(p, "build-normal"); await pick(p, "fur-short");

    // 5) 앉은 꼬리: 떨림·바닥 뚫림 0
    const tj = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, S = n.S, F = n.floorY; let jit = 0, below = 0;
      for (const style of [0, 1]) {
        n.setPose("stand"); n.step(240); n.setPose("sit"); let prev = null, prevD = null;
        for (let i = 0; i < 120 * 8; i++) { n.step(1); const T = c.tail.map((q) => [q.x, q.y]);
          if (i > 120) { below = Math.max(below, ...T.map((q) => (q[1] - F) / S));
            if (prev) { const d = T.map((q, k) => q[1] - prev[k][1]); if (prevD) d.forEach((v, k) => { if (Math.abs(v) > 0.15 * S && Math.abs(prevD[k]) > 0.15 * S && Math.sign(v) !== Math.sign(prevD[k])) jit++; }); prevD = d; } }
          prev = T; }
      }
      n.setPose("stand"); return { jit, below };
    });
    check("앉은 꼬리 떨림", tj.jit, tj.jit === 0);
    check("앉은 꼬리 바닥 뚫림", `${Math.max(0, tj.below).toFixed(2)} 단위`, tj.below <= 0.01);

    // 6) 웃는 중·자는 중 깜빡임 0, 평소엔 깜빡임
    const bl = {};
    for (const mood of ["idle", "happy", "sleepy"]) {
      await pick(p, `mood-${mood}`);
      bl[mood] = await p.evaluate(() => { const n = window.__neko, c = n.cat; n.step(240); let b = 0, prev = -1; for (let i = 0; i < 120 * 20; i++) { n.step(1); if (c.blinkP >= 0 && prev < 0) b++; prev = c.blinkP; } return b; });
    }
    check("깜빡임: 평소 있음 / 웃음·잠 없음", JSON.stringify(bl), bl.idle > 0 && bl.happy === 0 && bl.sleepy === 0);
    await pick(p, "mood-idle");

    // 7) 관절 뒤집힘: 활동 × 체형 × 다리 길이(상자 안은 가려져서 뺀다)
    let flips = 0, worstJump = 0;
    for (const ll of ["short", "long"]) for (const bd of ["slim", "chubby"]) {
      await pick(p, `legs-${ll}`); await pick(p, `build-${bd}`);
      const r = await p.evaluate((ACTS) => {
        const n = window.__neko, c = n.cat, S = n.S; let flips = 0, jump = 0;
        for (const act of ACTS.filter((a) => a !== "box" && a !== "climb")) {
          n.step(240); n.act(act); const side = {}, prev = {};
          for (let i = 0; i < 120 * 5; i++) { n.step(1);
            c.legs.forEach((L, li) => { const h = L.hipW, k = L.knee, f = L.footW, ux = f[0] - h[0], uy = f[1] - h[1], d = Math.hypot(ux, uy) || 1;
              if (prev[li] && c.mode === "act") jump = Math.max(jump, Math.hypot(k[0] - prev[li][0], k[1] - prev[li][1]) / S); prev[li] = k.slice();
              const cr = (ux * (k[1] - h[1]) - uy * (k[0] - h[0])) / d / S, sg = cr > 1.5 ? 1 : cr < -1.5 ? -1 : 0;
              if (sg && side[li] && sg !== side[li] && c.mode === "act") flips++; if (sg) side[li] = sg; });
          }
          n.act(null); n.step(200);
        }
        return { flips, jump };
      }, ACTS);
      flips += r.flips; worstJump = Math.max(worstJump, r.jump);
    }
    check("관절 뒤집힘(상자·벽 타기 제외)", flips, flips === 0, `최대 한 프레임 이동 ${worstJump.toFixed(1)} 단위`);
    await p.close();
  }

  // 8) 잡혔을 때 머리-목 벌어짐 ≤ 3, 평소 ≤ 6
  {
    const p = await open();
    await p.evaluate(() => { window.__gap = {}; const n = window.__neko, c = n.cat, st = n.step; n.step = (k) => { for (let i = 0; i < k; i++) { st(1); const g = Math.hypot(c.head.x - c.headAnc[0], c.head.y - c.headAnc[1]) / n.S; window.__gap[c.mode] = Math.max(window.__gap[c.mode] || 0, g); } }; });
    await p.evaluate(() => { const n = window.__neko; n.walkTo(500); n.step(300); n.jump(); n.step(200); });
    const box = await p.locator("#stage").boundingBox();
    const h = await p.evaluate(() => [window.__neko.cat.head.x, window.__neko.cat.head.y]);
    await p.mouse.move(box.x + h[0], box.y + h[1]); await p.mouse.down(); await p.mouse.move(box.x + h[0] + 8, box.y + h[1] - 40, { steps: 3 });
    for (let k = 0; k < 10; k++) { await p.mouse.move(box.x + h[0] + (k % 2 ? 120 : -120), box.y + h[1] - 60, { steps: 6 }); await p.evaluate(() => window.__neko.step(8)); }
    await p.mouse.up(); await p.evaluate(() => window.__neko.step(300));
    const g = await p.evaluate(() => window.__gap);
    const grabbed = g.grabbed || 0, other = Math.max(0, ...Object.entries(g).filter(([m]) => m !== "grabbed").map(([, v]) => v));
    check("머리-목 벌어짐(잡힘 ≤3, 평소 ≤6)", `잡힘 ${grabbed.toFixed(1)} · 평소 ${other.toFixed(1)}`, grabbed <= 3.01 && other <= 6.01);
    await p.close();
  }

  // 9) 앱 자리 크기(높이 기준): 고양이가 무대 밖으로 잘리지 않는가(산책 켜고 20초).
  //    사이드바 패널 최소·기본·최대 높이와 채팅 바 아래 띠
  for (const [w, h] of [[220, 150], [220, 200], [220, 320], [320, 320], [900, 150]]) {
    const p = await open(`?w=${w}&h=${h}&scale=height&transparent=1`, { width: 1000, height: 1000 }, 1);
    await p.click("#wander"); // 산책 다시 켬
    const r = await p.evaluate(() => {
      const n = window.__neko, cv = document.getElementById("stage"), g = cv.getContext("2d"); let cut = 0, frames = 0;
      for (let i = 0; i < 120 * 20; i++) { n.step(1); if (i % 30) continue; n.draw(); frames++;
        const w = cv.width, h = cv.height, d = g.getImageData(0, 0, w, h).data; let edge = false;
        for (let y = 0; y < h && !edge; y++) for (const x of [0, w - 1]) if (d[(y * w + x) * 4 + 3] > 200) { edge = true; break; }
        for (let x = 0; x < w && !edge; x++) if (d[x * 4 + 3] > 200) edge = true;
        if (edge) cut++; }
      return { cut, frames, S: n.S };
    });
    check(`자리 ${w}×${h}: 고양이가 가장자리에서 잘림`, `${r.frames}장 중 ${r.cut}장 (크기 ${r.S.toFixed(2)})`, r.cut === 0);
    await p.close();
  }

  // 10) 쓰다듬기: 처음엔 웃고(하트), 너무 오래 만지면 웃음을 멈추고 귀를 젖히고 피한다(같은 쪽으로 꾸준히)
  {
    const p = await open();
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat; n.step(240); const x0 = c.x;
      let firstOk = null, smileWhileSulk = 0, sulkFrames = 0, sulkAge = 0, earSum = 0, refused = 0, back = 0, prevDx = 0;
      for (let i = 0; i < 120 * 18; i++) {
        if (i % 40 === 0 && i < 120 * 15) { const ok = n.react("pet"); if (firstOk === null) firstOk = ok; if (!ok) refused++; }
        n.step(1);
        sulkAge = c.petSulk > 0 ? sulkAge + 1 : 0; // 짜증이 시작되고 0.5초(눈·귀가 바뀌는 시간) 뒤부터 본다
        if (sulkAge > 60) { sulkFrames++; smileWhileSulk = Math.max(smileWhileSulk, c.smile.x); earSum += (c.ears[0].x + c.ears[1].x) / 2; } // 두 귀 평균(시선 쪽으로 귀가 돌아 한쪽이 덜 젖혀진다)
        const dx = (c.x - x0) / n.S; if (i % 60 === 0) { if (Math.sign(dx) * (dx - prevDx) < -2) back++; prevDx = dx; }
      }
      return { firstOk, smileWhileSulk, sulkFrames, ear: earSum / Math.max(1, sulkFrames), refused, moved: Math.abs((c.x - x0) / n.S), back };
    });
    const ok = r.firstOk === true && r.refused > 0 && r.smileWhileSulk < 0.15 && r.ear > 0.25 && r.moved > 40 && r.back === 0;
    check("쓰다듬기 과자극: 웃음 멈춤·귀 젖힘·피함", `거절 ${r.refused}번 · 짜증 중 웃음 ${r.smileWhileSulk.toFixed(2)} · 귀 ${r.ear.toFixed(2)} · ${r.moved.toFixed(0)}단위 피함 · 되돌아옴 ${r.back}`, ok);
    await p.close();
  }

  // 11) 그리기 시간(DPR 2)
  {
    const p = await open("", { width: 760, height: 1000 }, 2);
    const ms = {};
    for (const [name, fur, pats] of [["단모", "short", []], ["장모+삼색", "long", ["calico", "white"]]]) {
      await pick(p, `fur-${fur}`);
      for (const pt of ["white", "calico", "tabby", "point"]) { const on = await p.$eval(`#pattern-${pt}`, (e) => e.checked); if (on !== pats.includes(pt)) await pick(p, `pattern-${pt}`); }
      ms[name] = await p.evaluate(() => { const n = window.__neko; n.step(60); const t0 = performance.now(); for (let i = 0; i < 120; i++) { n.step(1); n.draw(); } return (performance.now() - t0) / 120; });
    }
    check("그리기 시간(ms/프레임, DPR 2)", Object.entries(ms).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(" · "), Object.values(ms).every((v) => v < 16));
    await p.close();
  }

  check("실행 오류", errors.length ? errors.slice(0, 3).join(" | ") : 0, errors.length === 0);
} finally {
  await browser.close();
  await server.close();
}

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name.padEnd(w)}  ${r.value}${r.note ? `  (${r.note})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
