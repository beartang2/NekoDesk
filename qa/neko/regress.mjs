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
const ACTS = ["draw", "music", "butterfly", "snack", "stretch", "typing", "reading", "stamp", "groom", "knead", "yarn", "box", "window", "climb", "think", "wait", "meal", "hungry", "dig", "calendar", "erase", "gaze"];

try {
  // 1) 활동 전부를 12초씩 + 빠르게 바꾸기 + 밖에서 활동 더하기: 값이 깨지지 않는가
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
    check(`활동 ${ACTS.length}개·빠른 전환·외부 활동: 값 유한`, r.bad.length ? r.bad.join(",") : "모두 정상", r.bad.length === 0 && r.finite && r.act === "wave");
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

  // 9-0) 창 크기를 바꾸는 동안 깜빡이지 않는다: 크기 알림을 받은 그 자리에서 다시 그려, 캔버스가 빈 채로 화면에 나가지 않는다
  {
    const p = await open(`?w=220&h=200&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(() => {
      const n = window.__neko, cv = document.getElementById("stage"), g = cv.getContext("2d");
      const inked = () => { const d = g.getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 16) if (d[i] > 200) return true; return false; };
      n.step(60); n.draw();
      let blank = 0;
      for (let k = 0; k < 20; k++) { cv.style.width = 220 + k * 13 + "px"; cv.style.height = 200 + (k % 5) * 9 + "px"; n.resize(); if (!inked()) blank++; }
      return { blank };
    });
    check("창 크기 바꾸는 동안: 크기가 바뀐 직후에도 그림이 있다(깜빡임 없음)", `20번 중 빈 캔버스 ${r.blank}`, r.blank === 0);
    await p.close();
  }

  // 9-a) 활동 도중 자리가 바뀌어도(사이드바 → 채팅 바 아래, 높이 끌기) 소품이 고양이와 같은 배율·간격을 지킨다.
  //      예전엔 고양이만 새 크기가 되고 상자는 옛 크기·자리에 남았다. 고양이 자리는 무대 폭 비율을 지킨다.
  for (const [act, key, w, h] of [["box", "box", 900, 150], ["box", "box", 220, 320], ["hungry", "bowl", 900, 150]]) {
    const p = await open(`?w=220&h=200&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const before = await p.evaluate(([act, key]) => {
      const n = window.__neko; n.act(act); n.step(360); const o = n.cat.act[key];
      return { w: (o.w ?? 0) / n.S, dx: (o.x - n.cat.x) / n.S, at: n.cat.x / n.W };
    }, [act, key]);
    await p.evaluate(([w, h]) => { const s = document.getElementById("stage"); s.style.width = w + "px"; s.style.height = h + "px"; }, [w, h]);
    await p.waitForTimeout(150);
    const after = await p.evaluate((key) => { const n = window.__neko, o = n.cat.act[key]; return { w: (o.w ?? 0) / n.S, dx: (o.x - n.cat.x) / n.S, at: n.cat.x / n.W }; }, key);
    const ok = Math.abs(after.w - before.w) < 0.5 && Math.abs(after.dx - before.dx) < 0.5 && Math.abs(after.at - before.at) < 0.02;
    check(`자리 220×200 → ${w}×${h} (${act}): 소품이 고양이를 따라 커지고 옮겨진다`, `폭 ${before.w.toFixed(1)}→${after.w.toFixed(1)} · 간격 ${before.dx.toFixed(1)}→${after.dx.toFixed(1)} · 자리 ${before.at.toFixed(2)}→${after.at.toFixed(2)}`, ok);
    await p.close();
  }

  // 9-c) 입에 물기(docs/neko-gifts.md §6): 문 물건이 무대 크기·자리가 바뀌어도 입(머리)을 따라가고,
  //      그 위를 누르면 쓰다듬기가 아니라 carryPress 가 온다. 누워 자면 바닥에 내려 둔다.
  {
    const p = await open(`?w=220&h=200&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(async () => {
      const n = window.__neko, cv = document.getElementById("stage"), oc = new OffscreenCanvas(48, 40);
      oc.getContext("2d").fillRect(0, 0, 48, 40);
      n.carry([{ id: "a", kind: "image", image: await createImageBitmap(oc) }, { id: "b", kind: "shape", shape: { parts: [{ t: "circle", x: 0, y: -6, r: 6, c: "gold" }] } }]);
      n.step(120); n.draw();
      const near = () => { const b = n.carryRect(), h = n.cat.head; return Math.hypot(b.x + b.w / 2 - h.x, b.y - h.y) / n.S; };
      const before = near();
      cv.style.width = "900px"; cv.style.height = "150px"; n.resize(); n.step(60); n.draw();
      const after = near();
      const b = n.carryRect(), cx = b.x + b.w / 2, cy = b.y + b.h / 2, rect = cv.getBoundingClientRect();
      let press = 0, pet = 0; n.on("carryPress", () => press++); n.on("pet", () => pet++);
      for (const type of ["pointerdown", "pointerup"]) cv.dispatchEvent(new PointerEvent(type, { clientX: rect.left + cx, clientY: rect.top + cy, pointerId: 1, bubbles: true }));
      n.setPose("lie"); n.step(300); n.draw();
      const lb = n.carryRect(), onFloor = Math.abs(lb.y + lb.h - 3 * n.S - n.floorY) < 2;
      const kept = n.carried().length, dropped = n.drop().length;
      return { before, after, hit: n.hitCarry(2, 2), press, pet, onFloor, kept, dropped, left: n.carried().length };
    });
    check("입에 물기: 크기·자리가 바뀌어도 입을 따라간다(머리에서 떨어진 정도)", `${r.before.toFixed(1)} → ${r.after.toFixed(1)}`, Math.abs(r.after - r.before) < 6 && r.after < 40);
    check("입에 물기: 문 물건을 누르면 carryPress(쓰다듬기 아님)", `carryPress ${r.press} · pet ${r.pet} · 빈 곳 ${r.hit}`, r.press === 1 && r.pet === 0 && r.hit === null);
    check("입에 물기: 누워 자면 바닥에, 놓으면 비워진다", `바닥 ${r.onFloor} · 물던 ${r.kept} → 뺀 ${r.dropped} · 남은 ${r.left}`, r.onFloor && r.kept === 2 && r.dropped === 2 && r.left === 0);
    await p.close();
  }

  // 9-d) 바닥에 놓은 선물(docs/neko-gifts.md §4): 자리는 무대 폭 비율이라 크기·자리가 바뀌어도 같은 비율 자리에 그려진다
  {
    const p = await open(`?w=220&h=200&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(() => {
      const n = window.__neko, cv = document.getElementById("stage"), g = cv.getContext("2d");
      n.setDecor([{ id: "x", u: 0, shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] } }]);
      const red = () => { n.step(90); n.draw(); const dpr = cv.width / n.W, u = (32 * n.S) / 14;
        const d = g.getImageData(Math.round(16 * n.S * dpr), Math.round((n.floorY - 7 * u) * dpr), 1, 1).data; return d[0] > 180 && d[1] < 140 && d[3] > 200; };
      const a = red();
      cv.style.width = "900px"; cv.style.height = "150px"; n.resize();
      return { a, b: red() };
    });
    check("바닥에 놓은 선물: 크기·자리가 바뀌어도 비율 자리에 그려진다", `220×200 ${r.a} · 900×150 ${r.b}`, r.a && r.b);
    await p.close();
  }

  // 9-f) 놓아 둔 선물 옮기기(docs/neko-gifts.md §4): 잡고 위로 끌면 벽에 걸리고, 자리가 바뀌어도 비율을 지키고, 우클릭하면 치워진다
  {
    const p = await open(`?w=320&h=240&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(() => {
      const n = window.__neko, cv = document.getElementById("stage"), rect = () => cv.getBoundingClientRect(), ev = [];
      n.on("decorMove", (e) => ev.push(["move", e])); n.on("decorMenu", (e) => ev.push(["menu", e]));
      n.setWander(false); n.cat.x = n.W * 0.8; n.step(60);
      n.setDecor([{ id: "g", surface: "floor", u: 0.1, scale: 0.5, shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] } }]); // 0.5 = 예전 기본 크기
      n.step(90); n.draw();
      const boxOf = () => { for (let y = 0; y < n.floorY; y += 2) for (let x = 0; x < n.W; x += 2) if (n.hitDecor(x, y)) return [x, y]; return null; };
      const at = boxOf(), R = rect(), fire = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { clientX: R.left + x, clientY: R.top + y, pointerId: 7, bubbles: true, button: extra.button ?? 0 }));
      const [x0, y0] = [at[0] + 4, at[1] + 4];
      fire("pointerdown", x0, y0); fire("pointermove", x0 + 40, y0 - 90); fire("pointerup", x0 + 40, y0 - 90);
      const moved = ev[0] && ev[0][1];
      n.setDecor([{ id: "g", scale: 0.5, shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] }, ...moved }]); n.step(60); n.draw();
      const hitBefore = !!boxOf();
      cv.style.width = "900px"; cv.style.height = "150px"; n.resize(); n.step(60); n.draw();
      const b2 = boxOf(), span = n.floorY - (32 * n.S) - 10 * n.S, wallOk = !!b2 && moved && moved.surface === "wall";
      const R2 = rect(); cv.dispatchEvent(new MouseEvent("contextmenu", { clientX: R2.left + b2[0] + 2, clientY: R2.top + b2[1] + 2, bubbles: true, cancelable: true }));
      // 우클릭은 바로 치우지 않고 '정리' 버튼 자리(물건 오른쪽 위)를 알린다 — 물건은 그대로
      const menu = ev.find(([k]) => k === "menu"), mx = menu && menu[1];
      const menuOk = !!mx && mx.id === "g" && Math.abs(mx.x - b2[0]) < 60 * n.S && mx.y < b2[1] + 4;
      return { moved, hitBefore, wallOk, menuOk, kept: !!boxOf(), span: Math.round(span) };
    });
    check("놓아 둔 선물: 잡고 위로 끌면 벽에 걸린다(decorMove)", JSON.stringify(r.moved), !!r.moved && r.moved.surface === "wall" && r.moved.v > 0 && r.moved.v <= 1);
    check("놓아 둔 선물: 크기·자리가 바뀌어도 벽 자리에 있고, 우클릭하면 바로 치우지 않고 정리 버튼 자리를 알린다", `벽 ${r.wallOk} · 버튼 자리 ${r.menuOk} · 그대로 ${r.kept}`, r.hitBefore && r.wallOk && r.menuOk && r.kept);
    await p.close();
  }

  // 9-g) 선물 갖고 놀기(docs/neko-gifts.md §5): 노는 방식마다 다가가서 논다. 굴리기·물고 옮기기는 자리가 바뀌어 decorMove,
  //      끝나면 물건이 숨지 않고 바닥에 있다. 벽에 건 건 올려다본다
  {
    const p = await open(`?w=680&h=300&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, out = {};
      const shapes = { round: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] }, flat: { parts: [{ t: "ellipse", x: 0, y: -3, rx: 13, ry: 3, c: "gray" }] } };
      n.setWander(false);
      for (const [play, surface] of [["roll", "floor"], ["bat", "floor"], ["sniff", "floor"], ["sit_on", "floor"], ["carry", "floor"], ["sniff", "wall"]]) {
        n.act(null); n.step(120); c.x = n.W * 0.75; c.vx = 0; n.step(60);
        let moves = 0; const off = n.on("decorMove", () => moves++);
        n.setDecor([{ id: "g", surface, u: 0.25, v: 0.5, play, scale: 0.5, shape: play === "sit_on" ? shapes.flat : shapes.round }]); // 예전 기본 크기(굴리고 물 만한)
        n.act("giftplay");
        let acted = 0, minDx = 1e9;
        for (let i = 0; i < 120 * 25; i++) { n.step(1); if (c.mode === "act") acted++; if (i % 10 === 0) n.draw(); }
        // 그만하게 한 뒤에 본다: 마침 물고 옮기는 중이었어도 그 자리에 내려놓아야 한다
        n.act(null); n.step(30); n.draw(); off();
        const box = (() => { for (let y = 0; y < n.floorY + 2; y += 2) for (let x = 0; x < n.W; x += 2) if (n.hitDecor(x, y)) return [x, y]; return null; })();
        out[`${play}/${surface}`] = { acted: acted > 30, moves, visible: !!box, carrying: n.carried().length };
      }
      // 놀던 선물이 목록에서 빠지면(버리기·치우기·옮기기) 빈 자세로 멈추지 않고 그 판을 끝낸다
      n.act(null); n.step(120); c.x = n.W * 0.75; c.vx = 0; n.step(60);
      n.setDecor([{ id: "x", surface: "floor", u: 0.25, play: "sit_on", shape: shapes.flat }]); n.act("giftplay");
      let acting = false; for (let i = 0; i < 120 * 20 && !acting; i++) { n.step(1); acting = c.mode === "act"; }
      n.setDecor([]); n.step(30);
      out.gone = { acting, mode: c.mode };
      n.act(null);
      return out;
    });
    const ok = (k, needMove) => r[k].acted && r[k].visible && r[k].carrying === 0 && (!needMove || r[k].moves > 0);
    check("선물 갖고 놀기: 굴리기·물고 옮기기는 옮겨 놓고 decorMove", `굴리기 ${JSON.stringify(r["roll/floor"])} · 물기 ${JSON.stringify(r["carry/floor"])}`, ok("roll/floor", true) && ok("carry/floor", true));
    check("선물 갖고 놀기: 놀던 선물이 빠지면(버리기 등) 빈 자세로 멈추지 않고 끝낸다", JSON.stringify(r.gone), r.gone.acting && r.gone.mode !== "act");
    check("선물 갖고 놀기: 톡·냄새·위에 앉기·벽 올려다보기", ["bat/floor", "sniff/floor", "sit_on/floor", "sniff/wall"].map((k) => `${k} ${r[k].acted}`).join(" · "), ["bat/floor", "sniff/floor", "sit_on/floor", "sniff/wall"].every((k) => ok(k, false)));
    await p.close();
  }

  // 9-e) 화면 모드(docs/neko-screen-mode.md §9 E1~E5): 세계 = 창 전체, 캔버스는 고양이 둘레만 따라간다.
  //      크기 고정·바닥 지정·세계 좌표 hit·높이서 떨어지기·나비는 영역 안
  {
    const p = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, cv = document.getElementById("stage"), c = n.cat, o = {};
      n.setGround(760); n.step(200); n.draw();
      const follows = () => { const R = n.region; return Math.abs(R.x + R.w / 2 - c.x) < 1 && Math.abs(R.y + R.h * 0.7 - c.y) < 1 && cv.style.transform === `translate(${R.x}px, ${R.y}px)`; };
      o.size = cv.width === Math.round(n.region.w) && n.region.w === Math.round(600 * 0.8) && n.region.h === Math.round(440 * 0.8);
      o.follow0 = follows();
      n.walkTo(1100); for (let i = 0; i < 600; i++) n.step(1); n.draw();
      o.follow1 = follows() && c.x > 800;
      o.hit = n.hit(c.x, c.y) && !n.hit(c.x, c.y - 300);
      n.setGround(500); n.step(240); o.ground = n.floorY === 500 && c.y < 500 && c.y > 400;
      n.setScale(1.2); n.step(30); n.draw(); o.scale = n.S === 1.2 && n.region.w === 720 && follows();
      n.setScale(0.8); n.setGround(760); n.step(240);
      c.mode = "fall"; c.modeT = 0; c.y = 40; c.vy = 0; c.vx = 0;
      let vmax = 0, t = 0; while (c.mode === "fall" && t < 900) { n.step(1); vmax = Math.max(vmax, c.vy); t++; }
      o.fall = { landed: c.mode === "land", vmax: Math.round(vmax), cap: Math.round(1500 * n.S) };
      n.act("butterfly"); let out = 0;
      for (let i = 0; i < 120 * 20; i++) { n.step(1); if (i % 12) continue; n.draw(); const b = c.act && c.act.b, R = n.region;
        if (b && b.rt < 99 && (b.x < R.x || b.x > R.x + R.w || b.y < R.y || b.y > R.y + R.h)) out++; }
      o.butterflyOut = out;
      return o;
    });
    check("화면 모드: 캔버스는 고양이 둘레 600×440 단위, 매 프레임 고양이를 따라간다", `크기 ${r.size} · 처음 ${r.follow0} · 걸은 뒤 ${r.follow1}`, r.size && r.follow0 && r.follow1);
    check("화면 모드: 세계 좌표 hit · 바닥 지정 · 크기 고정", `hit ${r.hit} · 바닥 ${r.ground} · 크기 ${r.scale}`, r.hit && r.ground && r.scale);
    check("화면 모드: 화면 위쪽에서 놓아도 속도 상한 안에서 떨어져 착지", `착지 ${r.fall.landed} · 최고 속도 ${r.fall.vmax} ≤ ${r.fall.cap}`, r.fall.landed && r.fall.vmax <= r.fall.cap);
    check("화면 모드: 나비는 고양이 둘레 영역 안에서만 난다", `밖으로 나간 장 ${r.butterflyOut}`, r.butterflyOut === 0);
    await p.close();
  }

  // 9-h) 화면 모드 여러 모니터(docs/neko-screen-mode.md 3단계): 닫힌 가장자리는 벽, walkOut 하면 넘어가며 edge 한 번,
  //      shiftWorld 하면 걷던 걸음 그대로 새 화면 쪽에서 이어 걷고, 잡고 끌던 중에도 커서 밑에 그대로, 창 크기가 바뀌어도 자리 그대로
  {
    const p = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, o = {}, edges = [];
      n.on("edge", (s) => edges.push(s));
      n.setGround(760); n.step(200);
      // 닫혀 있으면 화면 밖으로 시켜도 안에서 멈춘다
      n.walkTo(5000); n.step(120 * 12); o.closed = c.x < n.W && edges.length === 0;
      // 오른쪽으로 나가기 → edge 한 번
      n.walkOut("right"); let t = 0; while (!edges.length && t < 120 * 15) { n.step(1); t++; }
      o.edge = edges.join(",");
      const vx = c.vx, x0 = c.x, W = n.W;
      // 호스트: 창을 오른쪽 모니터로 → shiftWorld(-옛 폭) → setGround → setEdges(닫힘)
      n.shiftWorld(-W, 0); n.setGround(760); n.setEdges({ left: false, right: false });
      o.shift = Math.abs(c.x - (x0 - W)) < 1 && c.mode === "walk" && Math.sign(c.vx) === Math.sign(vx);
      n.step(120 * 3); o.after = c.x > 0 && c.x < n.W && edges.length === 1;
      // 창 크기가 바뀌어도(다른 모니터) 고양이 자리는 그대로
      const xb = c.x; n.resize(); o.resizeKeeps = Math.abs(c.x - xb) < 0.01;
      // 잡고 끄는 중에 옮겨도 목덜미 자리가 같이 옮겨진다
      n.step(240); const s0 = { x: c.scruff.x, y: c.scruff.y }; n.shiftWorld(300, -40);
      o.grabShift = Math.abs(c.scruff.x - s0.x - 300) < 0.01 && Math.abs(c.scruff.y - s0.y + 40) < 0.01;
      n.shiftWorld(-300, 40);
      // 닫힌 쪽 밖에 있으면 순간이동하지 않고 걸어 들어온다
      n.step(240); c.x = -150; n.setEdges({ left: false, right: false }); const xs = [c.x];
      for (let i = 0; i < 120 * 6; i++) { n.step(1); if (i % 60 === 0) xs.push(c.x); }
      o.walkIn = xs.every((x, i) => i === 0 || x >= xs[i - 1] - 0.5) && c.x > 0 && xs[1] < 0;
      return o;
    });
    check("여러 모니터: 닫힌 가장자리는 벽, walkOut 이면 넘어가며 edge 한 번", `닫힘 ${r.closed} · edge ${r.edge}`, r.closed && r.edge === "right");
    check("여러 모니터: shiftWorld 뒤에도 걷던 걸음 그대로 새 화면에서 이어 걷는다", `옮김 ${r.shift} · 이어 걷기 ${r.after}`, r.shift && r.after);
    check("여러 모니터: 창 크기가 바뀌어도 자리 그대로 · 끌던 손도 같이 옮김 · 밖이면 걸어 들어옴", `크기 ${r.resizeKeeps} · 손 ${r.grabShift} · 걸어 들어옴 ${r.walkIn}`, r.resizeKeeps && r.grabShift && r.walkIn);
    await p.close();
  }

  // 9-h2) 바닥 높이가 다른 모니터로 건너가기(shiftWorld 의 ground): 걸어서 700 → 760 이면 발이 새 바닥에서 안 튀고 머리 높이도
  //       그대로, 잡고 끌어서 760 → 700 이면 목덜미가 커서 밑에 그대로(바닥 차이를 두 번 옮겨 튀었다가 돌아오던 것)
  {
    const p = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const walk = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, edges = [];
      n.on("edge", (s) => edges.push(s));
      n.setGround(700); n.step(200);
      n.walkOut("right"); let t = 0; while (!edges.length && t < 120 * 15) { n.step(1); t++; }
      const head0 = c.head.y - c.y, W = n.W;
      n.shiftWorld(-W, 60, 760); n.setEdges({ left: false, right: false });
      const feet = () => Math.max(...c.legs.map((L) => L.foot.y));
      let worstFoot = feet() - n.floorY, worstHead = 0;
      for (let i = 0; i < 60; i++) { n.step(1); worstFoot = Math.max(worstFoot, feet() - n.floorY); worstHead = Math.max(worstHead, Math.abs(c.head.y - c.y - head0)); }
      return { edge: edges.length === 1, floor: n.floorY, worstFoot: +worstFoot.toFixed(1), worstHead: +worstHead.toFixed(1) };
    });
    // 잡고 끌기: 진짜 마우스로 잡고, 창이 위로 60 올라간 모니터로 옮겨 붙으면 같은 커서가 창 좌표로 +60
    const at = await p.evaluate(() => { const n = window.__neko; n.setGround(760); n.step(240); return [n.cat.head.x, n.cat.head.y]; });
    const cy = at[1] - 120; // 끄는 커서(창 좌표)
    await p.mouse.move(at[0], at[1]); await p.mouse.down(); await p.mouse.move(at[0] + 10, cy, { steps: 6 });
    const before = await p.evaluate((cy) => { const n = window.__neko; n.step(120); return { grabbed: n.cat.mode === "grabbed", d: +(n.cat.scruff.y - cy).toFixed(1) }; }, cy);
    const drag = await p.evaluate((cy) => { const n = window.__neko; n.shiftWorld(0, 60, 700); return { d0: +(n.cat.scruff.y - cy - 60).toFixed(1) }; }, cy);
    await p.mouse.move(at[0] + 10, cy + 60);
    const after = await p.evaluate((cy) => {
      const n = window.__neko; let worst = 0;
      for (let i = 0; i < 60; i++) { n.step(1); worst = Math.max(worst, Math.abs(n.cat.scruff.y - cy - 60)); }
      return { worst: +worst.toFixed(1), floor: n.floorY };
    }, cy);
    // 커서가 창 밖(다른 모니터)으로 나가면 묶지 않고 따라간다 — held 가 경계를 넘어 호스트가 창을 옮길 수 있다
    const out = await p.evaluate(() => {
      const n = window.__neko, cv = document.getElementById("stage");
      cv.dispatchEvent(new PointerEvent("pointermove", { clientX: n.W + 214, clientY: 650, pointerId: 1, bubbles: true }));
      n.step(90); const held = n.held;
      cv.dispatchEvent(new PointerEvent("pointermove", { clientX: n.W - 20, clientY: 650, pointerId: 1, bubbles: true }));
      n.step(90); const back = n.held;
      return { past: !!held && held[0] > n.W + 100, clampedBack: !!back && back[0] <= n.W - 60 * n.S + 1 };
    });
    await p.mouse.up();
    const released = await p.evaluate(() => { window.__neko.step(30); return window.__neko.held; });
    const dragOk = before.grabbed && Math.abs(drag.d0 - before.d) < 2 && after.worst < Math.abs(before.d) + 4 && after.floor === 700;
    check("여러 모니터: 바닥이 다른 모니터로 걸어 건너가면 발이 새 바닥에서 안 튀고 머리 높이 그대로", JSON.stringify(walk), walk.edge && walk.floor === 760 && walk.worstFoot < 3 && walk.worstHead < 2);
    check("여러 모니터: 바닥이 다른 모니터로 끌어 건너가면 목덜미가 커서 밑에 그대로", JSON.stringify({ before, drag, after }), dragOk);
    check("여러 모니터: 끄는 커서가 창 밖이면 묶지 않고 따라가 경계를 넘는다(held), 돌아오면 다시 묶음, 놓으면 null", JSON.stringify({ ...out, released }), out.past && out.clampedBack && released === null);
    await p.close();
  }

  // 9-i) 선물 크기(small·medium·large): 같은 모양도 실제 크기대로 다르게 그리고, 큰 것도 고양이 몸보다 작다
  {
    const p = await open(`?w=680&h=240&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(() => {
      const n = window.__neko, shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
      n.cat.x = n.W * 0.5; n.step(30);
      n.setDecor([{ id: "s", surface: "floor", u: 0.05, size: "small", shape }, { id: "m", surface: "floor", u: 0.3, shape }, { id: "l", surface: "floor", u: 0.95, size: "large", shape }]);
      n.step(120); n.draw();
      const width = (id) => { let a = null, b = null; for (let x = 0; x < n.W; x += 0.5) for (let y = n.floorY - 40 * n.S; y < n.floorY; y += 1) if (n.hitDecor(x, y) === id) { a ??= x; b = x; break; } return b - a; };
      return { s: width("s"), m: width("m"), l: width("l"), body: 100 * n.S };
    });
    check("선물 크기: small < medium < large, 기본은 예전(32)의 2배 — medium 한 변이 몸길이의 64%쯤", `폭 ${r.s.toFixed(0)} · ${r.m.toFixed(0)} · ${r.l.toFixed(0)} (몸 ${r.body.toFixed(0)})`, r.s < r.m && r.m < r.l && r.m > 0.5 * r.body && r.m < 0.75 * r.body);
    await p.close();
  }

  // 9-j) 선물 놀이 순서·큰 물건 놀이(docs/neko-gifts.md §5): 놓인 건 오래 안 논 것부터 돌아가며 하나도 빠짐없이,
  //      큰 걸 물고 옮기기·굴리기는 큰 물건 놀이(발톱 긁기·기대어 자기·뒤에 숨기)로, 작은 데 큰 물건 놀이는 냄새로
  {
    const p = await open(`?w=900&h=260&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] }, played = [];
      n.setWander(false); n.on("decorPlayed", (e) => played.push(e.id));
      n.setDecor(["a", "b", "c"].map((id, i) => ({ id, surface: "floor", u: 0.15 + i * 0.35, play: "sniff", shape })));
      n.act("giftplay");
      for (let i = 0; i < 120 * 40 && played.length < 4; i++) n.step(1);
      const rotation = played.slice(0, 3).sort().join(""), plays = {};
      n.act(null); n.step(30);
      for (const [size, play] of [["large", "carry"], ["large", "roll"], ["large", "lean"], ["large", "hide"], ["large", "scratch"], ["small", "scratch"]]) {
        n.setDecor([{ id: size + play, surface: "floor", u: 0.3, size, play, shape }]);
        n.act("giftplay"); n.step(1); const chosen = c.act && c.act.play;
        let acted = 0, done = 0; const off = n.on("decorPlayed", () => done++);
        for (let i = 0; i < 120 * 20 && !done; i++) { n.step(1); if (c.mode === "act") acted++; if (i % 12 === 0) n.draw(); }
        off(); n.act(null); n.step(30);
        plays[size + "/" + play] = { chosen, acted: acted > 20, done };
      }
      // 사용자 배율(선물함 슬라이더): 실제 그리는 크기로 고른다
      const scaled = {};
      for (const [size, scale, play] of [["medium", 2, "carry"], ["small", 0.5, "lean"], ["medium", 3, "sit_on"], ["small", 0.5, "roll"]]) {
        n.setDecor([{ id: "s" + size + scale, surface: "floor", u: 0.3, size, scale, play, shape }]);
        n.act("giftplay"); n.step(1); scaled[`${size}×${scale}/${play}`] = c.act && c.act.play; n.act(null); n.step(10);
      }
      return { rotation, played, plays, scaled };
    });
    const big = ["scratch", "lean", "hide"], P = r.plays;
    check("선물 배율: 놀이는 실제 크기로(중간×2 는 큰 물건 놀이, 작은×0.5 기대기는 냄새, 중간×3 위에 앉기는 기대기, 작은×0.5 굴리기 그대로)", JSON.stringify(r.scaled),
      big.includes(r.scaled["medium×2/carry"]) && r.scaled["small×0.5/lean"] === "sniff" && r.scaled["medium×3/sit_on"] === "lean" && r.scaled["small×0.5/roll"] === "roll");
    check("선물 놀이 순서: 놓인 셋을 하나도 빠짐없이 돌아가며 논다(decorPlayed)", `${r.played.join("→")}`, r.rotation === "abc");
    check("큰 물건: 물고 옮기기·굴리기는 큰 물건 놀이로, 큰 물건 놀이 셋은 실제로 논다, 작은 데선 냄새로",
      Object.entries(P).map(([k, v]) => `${k}→${v.chosen}${v.acted ? "" : "(안 함)"}`).join(" · "),
      big.includes(P["large/carry"].chosen) && big.includes(P["large/roll"].chosen) && big.every((b) => P["large/" + b].chosen === b && P["large/" + b].acted && P["large/" + b].done === 1) && P["small/scratch"].chosen === "sniff");
    await p.close();
  }

  // 9-k) 마당(화면 모드) 선물은 모니터마다 선물 창이 그리고 만진다(&decor=1 이 흉내). 엔진은 갖고 노는 동안 잡은 것만
  //      그리고 decorHeld 로 알린다: 가만있는 건 엔진이 안 그리고 누르기도 안 받는다. 굴리면 잡고(선물 창은 빼고 그림),
  //      끝나면 목록에서 빠지고 0.3초쯤 더 그린 뒤 선물 창에 넘긴다. 문 채로 목록에서 빠지면 입에서도 빠진다
  {
    const p = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8&decor=1`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, gw = window.__giftWin, c = n.cat, cv = document.getElementById("decor"), shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
      const inked = () => { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) k++; return k; };
      const engineHit = () => { for (let x = 0; x < n.W; x += 2) if (n.hitDecor(x, n.floorY - 8)) return true; return false; };
      const heldEv = []; n.on("decorHeld", (ids) => heldEv.push(ids.join(",")));
      n.setGround(760); n.step(60); c.x = 700; n.step(60);
      // 가만있는 선물: 선물 창만 그린다(멀리 있어도), 엔진은 안 그리고 안 누른다, 잡은 것 없음
      n.setDecor([{ id: "l", surface: "floor", u: 0.02, shape }, { id: "r", surface: "floor", u: 0.98, shape }]);
      n.step(60); n.draw();
      const still = { win: inked() > 100, engine: engineHit(), ev: heldEv.length };
      // 굴리기: 잡은 동안 선물 창은 빼고 그리고 엔진이 그린다(누를 수도 있다)
      n.setDecor([{ id: "g", surface: "floor", u: 0.45, play: "roll", scale: 0.5, shape }]); n.step(10);
      n.act("giftplay");
      let heldFrames = 0, swapOk = true, released = -1, graceDrawn = null;
      for (let i = 0; i < 120 * 30 && released < 0; i++) {
        n.step(1);
        if (gw.held.includes("g")) {
          heldFrames++;
          if (heldFrames % 15 === 1) { n.draw(); if (inked() !== 0 || !engineHit()) swapOk = false; }
        } else if (heldFrames) released = i;
      }
      if (released >= 0) { n.step(12); n.draw(); graceDrawn = engineHit(); } // 0.1초 뒤: 엔진이 아직 그린다
      n.act(null); n.step(60); n.draw(); // 0.6초 뒤: 엔진은 안 그리고 선물 창이 새 자리에
      const after = { engine: engineHit(), win: inked() > 100, last: heldEv[heldEv.length - 1] };
      // 굴러가는 중에 사용자가 선물 창에서 끌어 놓음(호스트가 자리를 바꿔 다시 넣음): 굴러가던 자리를 버리고 사용자 자리에 둔다
      const moves = []; n.on("decorMove", (e) => moves.push(e.u));
      n.setDecor([{ id: "u", surface: "floor", u: 0.45, play: "roll", scale: 0.5, shape }]); n.step(10);
      n.act("giftplay");
      let rolling = false;
      for (let i = 0; i < 120 * 30 && !rolling; i++) { n.step(1); rolling = c.act && c.act.stage === "rolling"; }
      moves.length = 0;
      n.setDecor([{ id: "u", surface: "floor", u: 0.9, play: "roll", scale: 0.5, shape }]);
      n.act(null); n.step(30);
      const userWins = { rolling, overwritten: moves.some((u) => u !== 0.9) };
      // 물고 옮기다 목록에서 빠짐(다른 모니터로 건너감 등): 잡은 목록과 입에서 빠진다
      n.setDecor([{ id: "m", surface: "floor", u: 0.45, play: "carry", scale: 0.5, shape }]); n.step(10);
      n.act("giftplay");
      let carried = false;
      for (let i = 0; i < 120 * 30 && !carried; i++) { n.step(1); carried = n.carried().length > 0 && gw.held.includes("m"); }
      n.setDecor([]); n.step(2);
      const gone = { carried, mouth: n.carried().length, last: heldEv[heldEv.length - 1] };
      n.act(null);
      return { still, heldFrames, swapOk, released: released >= 0, graceDrawn, after, gone, userWins };
    });
    check("마당 선물: 가만있는 건 선물 창만 그린다(엔진은 안 그리고 안 누른다)", JSON.stringify(r.still), r.still.win && !r.still.engine && r.still.ev === 0);
    check("마당 선물: 굴리는 동안 엔진이 잡고(decorHeld) 그리며 선물 창은 뺀다, 놓으면 0.3초쯤 더 그리고 넘긴다",
      `잡음 ${r.heldFrames}프레임 · 바꿔 그림 ${r.swapOk} · 놓음 ${r.released} · 잠깐 더 ${r.graceDrawn} · 뒤 ${JSON.stringify(r.after)}`,
      r.heldFrames > 30 && r.swapOk && r.released && r.graceDrawn === true && !r.after.engine && r.after.win && r.after.last === "");
    check("마당 선물: 물고 있던 게 목록에서 빠지면 잡은 목록·입에서도 빠진다", JSON.stringify(r.gone), r.gone.carried && r.gone.mouth === 0 && r.gone.last === "");
    check("마당 선물: 굴러가는 중에 사용자가 옮겨 놓으면 사용자 자리가 이긴다", JSON.stringify(r.userWins), r.userWins.rolling && !r.userWins.overwritten);
    await p.close();
  }

  // 9-l) 산책 중 팻말(화면 모드 마당): 고양이 대신 그 자리 바닥에 팻말, 누를 수 없고(클릭 통과), 다 서면 다시 안 그린다.
  //      돌아오면 팻말이 없어지고 고양이가 그 자리에 다시 보인다
  {
    const p = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8&decor=1`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage"), g = cv.getContext("2d");
      n.setGround(760); n.step(200); n.draw();
      const x0 = c.x, inked = () => { const d = g.getImageData(0, 0, cv.width, cv.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) k++; return k; };
      n.setAway(true);
      for (let i = 0; i < 120 * 2; i++) n.step(1);
      n.draw(); const signInk = inked(), hit = n.hit(x0, c.y), still = c.x === x0;
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.restore();
      n.step(30); n.draw(); const skipped = inked() === 0; // 다 섰으면 다시 안 그린다
      n.walkOut("right"); n.step(240); const noWalk = c.x === x0;
      n.setAway(false); n.step(30); n.draw();
      return { signInk: signInk > 500, hit, still, skipped, noWalk, back: inked() > 500 && n.hit(c.x, c.y) && Math.abs(c.x - x0) < 1 };
    });
    check("산책 중 팻말: 고양이 대신 팻말, 누를 수 없고 움직이지 않으며 다 서면 다시 안 그린다", `팻말 ${r.signInk} · 누르기 ${r.hit} · 그대로 ${r.still} · 다시 안 그림 ${r.skipped} · 걸어 나가기 막힘 ${r.noWalk}`, r.signInk && !r.hit && r.still && r.skipped && r.noWalk);
    check("산책 중 팻말: 돌아오면 팻말 대신 그 자리에 고양이", `돌아옴 ${r.back}`, r.back);
    await p.close();
  }

  // 9-m) 털실: 공은 자리의 실제 끝까지 굴러가 튕긴다(안쪽 '투명 벽' 없음). 끝에 붙은 공은 앞발을 뻗어 끌어내서,
  //      구석에서 헛발질만 되풀이하지 않는다. 좁은 자리도 공이 움직이고, 화면 모드에선 열린 가장자리로도 공이 안 나간다
  {
    const yarn = async (q, vp, start) => {
      const p = await open(q, vp);
      const r = await p.evaluate((start) => {
        const n = window.__neko, c = n.cat, S = n.S, W = n.W;
        n.step(60); n.act("yarn"); n.step(2);
        const A = c.act, b = A.ball;
        if (start.x === "L") b.x = 15 * S; else if (start.x === "R") b.x = W - 15 * S; else if (start.x != null) b.x = start.x * W;
        if (start.vx) b.vx = start.vx * S;
        let minX = Infinity, maxX = -Infinity, swipes = 0, kicks = 0, pulls = 0, sw = A.swipe, vx = b.vx;
        for (let i = 0; i < 120 * start.sec; i++) {
          n.step(1);
          if (sw < 0 && A.swipe >= 0) swipes++;
          if (Math.abs(b.vx - vx) > 50 * S && Math.abs(vx) < 60 * S) { kicks++; if (Math.sign(b.vx) !== c.face) pulls++; }
          sw = A.swipe; vx = b.vx; minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x);
        }
        return { minEdge: minX / S, maxEdge: (W - maxX) / S, swipes, kicks, pulls, span: (maxX - minX) / S, out: (start.x === "L" ? maxX : W - minX) / S };
      }, start);
      await p.close();
      return r;
    };
    const wide = await yarn("", { width: 760, height: 1000 }, { x: 0.5, vx: -700, sec: 4 });
    check("털실: 공이 자리의 실제 끝까지 굴러간다(투명 벽 없음)", `끝까지 ${wide.minEdge.toFixed(0)}단위(예전 150)`, wide.minEdge < 20);
    const L = await yarn("", { width: 760, height: 1000 }, { x: "L", sec: 25 }), R = await yarn("", { width: 760, height: 1000 }, { x: "R", sec: 25 });
    const ok = (r) => r.pulls > 0 && r.out > 160 && r.swipes - r.kicks <= 1; // 끝에서 160단위 넘게 끌어냈다
    check("털실: 끝에 붙은 공은 앞발을 뻗어 끌어내고, 헛발질을 되풀이하지 않는다", `왼쪽 끌어냄 ${L.pulls}·찬 ${L.kicks}/${L.swipes}·멀리 ${L.out.toFixed(0)} · 오른쪽 끌어냄 ${R.pulls}·찬 ${R.kicks}/${R.swipes}·멀리 ${R.out.toFixed(0)}`, ok(L) && ok(R));
    const narrow = await yarn("?w=220&h=200&scale=height", { width: 760, height: 1000 }, { sec: 25 });
    check("털실: 좁은 자리(220×200)도 공이 움직이고 헛발질을 되풀이하지 않는다", `찬 ${narrow.kicks}/${narrow.swipes} · 움직인 폭 ${narrow.span.toFixed(0)}단위`, narrow.kicks >= 5 && narrow.swipes - narrow.kicks <= 1);
    const p = await open("?world=1&fixed=0.8", { width: 1200, height: 700 });
    const w = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, S = n.S, W = n.W;
      n.setGround(600); n.step(60); n.setEdges({ left: true, right: true }); n.act("yarn"); n.step(2);
      const b = c.act.ball; let minX = Infinity, maxX = -Infinity;
      for (let k = 0; k < 6; k++) { b.x = (k % 2 ? 0.7 : 0.3) * W; b.vx = (k % 2 ? 900 : -900) * S; for (let i = 0; i < 600; i++) { n.step(1); minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x); } }
      return { inside: minX >= 0 && maxX <= W, near: minX < 20 * S || W - maxX < 20 * S, cat: c.x > 0 && c.x < W };
    });
    await p.close();
    check("털실: 화면 모드 열린 가장자리로도 공이 나가지 않는다(화면 끝에서 튕김)", `안 ${w.inside} · 끝까지 ${w.near} · 고양이 화면 안 ${w.cat}`, w.inside && w.near && w.cat);
  }

  // 9-n) 활동 겹치기(docs/neko-activity-mix.md 1부): 선언이 엔진 활동과 맞고, 음악은 모든 활동·기본 상태 위에 얹히며
  //      헤드폰을 낀 채 돌아다니고, 졸 때는 낀 채·누워 자면 벗는다. 주 활동이 끝나도 남고, 잡혀도 이어진다
  {
    const p = await open();
    const r = await p.evaluate(async () => {
      const { MIX, POSE_PART } = await import("/src/neko/engine/activity-mix.js");
      const n = window.__neko, c = n.cat, o = {};
      const acts = n.activities.filter((k) => k !== "wave"), decl = Object.keys(MIX).filter((k) => !k.startsWith("base:"));
      o.declMissing = acts.filter((k) => !MIX[k]); o.declExtra = decl.filter((k) => !acts.includes(k));
      const ok = () => [c.x, c.y, c.head.x, c.head.y, ...c.tail.map((t) => t.x)].every(Number.isFinite);
      const keys = new Set(), labels = new Set(); n.on("label", (l) => labels.add(l));
      o.bad = []; o.lost = [];
      n.step(60);
      for (const k of acts.filter((k) => k !== "music")) {
        n.act(k); n.step(30);
        if (!n.mix("music")) o.lost.push(k + ":거절");
        for (let s = 0; s < 120 * 12; s++) { n.step(1); if (c.actP) Object.keys(c.actP).forEach((x) => keys.add(x)); if (s % 6 === 0) n.draw(); if (!ok()) { o.bad.push(k); break; } }
        if (n.side !== "music") o.lost.push(k);
        n.act(null); n.mix(null); n.step(120);
      }
      o.unknownKeys = [...keys].filter((x) => x !== "add" && !POSE_PART[x]);
      o.label = [...labels].some((l) => l.startsWith("음악 들으며 "));
      // 헤드폰 낀 채 돌아다니기: 걷는 동안 음표는 앉아 있을 때보다 적다
      const notes = (sec, f) => { let k = 0, prev = c.side.noteT; for (let i = 0; i < 120 * sec; i++) { n.step(1); f && f(i); if (c.side.noteT > prev) k++; prev = c.side.noteT; } return k; };
      n.setPose("sit"); n.step(120); n.mix("music"); n.step(60);
      const sitNotes = notes(20);
      n.setPose("stand"); n.step(60);
      let walked = 0; const walkNotes = notes(20, (i) => { if (i % 240 === 0) n.walkTo(c.x < n.W / 2 ? n.W * 0.8 : n.W * 0.2); if (c.mode === "walk") walked++; });
      o.walk = { side: n.side, walked: walked / 120, sitNotes, walkNotes, label: [...labels].includes("음악 들으며 걷는 중") };
      n.setPose("loaf"); n.step(240); o.loaf = n.side;
      n.setPose("lie"); n.step(240); o.lie = n.side; o.lieRetry = n.mix("music");
      n.setPose("stand"); n.step(120); n.mix("music"); n.step(60);
      n.act("typing"); n.step(240); n.act(null); n.step(60); o.afterMain = [n.activity, n.side];
      n.act("music"); n.step(5); o.ride = [n.activity, n.side, c.act.t > 1];
      n.act(null); n.step(60); n.mix("music"); n.step(60);
      o.reject = n.mix("typing");
      return o;
    });
    check("겹치기: 선언(MIX)이 엔진 활동과 같고, pose 키가 부위 표 안에 있다", `빠짐 ${r.declMissing.join(",") || "없음"} · 남음 ${r.declExtra.join(",") || "없음"} · 모르는 키 ${r.unknownKeys.join(",") || "없음"}`, !r.declMissing.length && !r.declExtra.length && !r.unknownKeys.length);
    check("겹치기: 음악은 모든 활동 위에 12초씩 얹혀도 값 유한·헤드폰 유지·상태 글자", `깨짐 ${r.bad.join(",") || "없음"} · 빠짐 ${r.lost.join(",") || "없음"} · 글자 ${r.label}`, !r.bad.length && !r.lost.length && r.label);
    check("겹치기: 헤드폰 낀 채 돌아다니고 걷는 동안은 음표가 적다", `걸음 ${r.walk.walked.toFixed(1)}초 · 곁들임 ${r.walk.side} · 음표 앉아 ${r.walk.sitNotes}·걸어 ${r.walk.walkNotes} · "음악 들으며 걷는 중" ${r.walk.label}`, r.walk.side === "music" && r.walk.walked > 5 && r.walk.walkNotes < r.walk.sitNotes && r.walk.label);
    check("겹치기: 식빵으로 졸 땐 낀 채, 누워 자면 벗고 다시 못 씀", `식빵 ${r.loaf} · 누움 ${r.lie} · 다시 ${r.lieRetry}`, r.loaf === "music" && r.lie === null && r.lieRetry === false);
    check("겹치기: 주 활동이 끝나도 남고, act(음악)이면 옮겨 타며, 곁들임 아닌 건 거절", `끝난 뒤 ${r.afterMain.join("/")} · 옮겨 탐 ${r.ride.join("/")} · 거절 ${!r.reject}`, r.afterMain[0] === null && r.afterMain[1] === "music" && r.ride[0] === "music" && r.ride[1] === null && r.ride[2] && !r.reject);
    // 잡혀도 음악은 이어진다(목덜미를 잡고 위로)
    const box = await p.locator("#stage").boundingBox();
    const h = await p.evaluate(() => [window.__neko.cat.head.x, window.__neko.cat.head.y, window.__neko.side]);
    await p.mouse.move(box.x + h[0], box.y + h[1]); await p.mouse.down(); await p.mouse.move(box.x + h[0] + 8, box.y + h[1] - 60, { steps: 4 });
    const mid = await p.evaluate(() => { window.__neko.step(30); return [window.__neko.cat.mode === "grabbed", window.__neko.side]; });
    await p.mouse.up();
    const after = await p.evaluate(() => { window.__neko.step(240); return window.__neko.side; });
    const g = { grabbed: mid[0], side: mid[1], before: h[2], after };
    // 2단계 엔진: 쳐다보기는 사용자 쪽을 보며 가끔 천천히 눈을 감았다 뜨고, setChase(false) 면 커서를 따라오지 않는다
    const gz = await p.evaluate(() => {
      const n = window.__neko, c = n.cat; n.act(null); n.mix(null); n.step(240);
      n.act("gaze"); let lidMax = 0, lidMin = 1;
      for (let i = 0; i < 120 * 11; i++) { n.step(1); if (c.actP && c.actP.lid != null) { lidMax = Math.max(lidMax, c.actP.lid); lidMin = Math.min(lidMin, c.actP.lid); } }
      n.act(null); n.step(120);
      const cv = document.getElementById("stage"), R = cv.getBoundingClientRect(), x0 = c.x;
      n.setChase(false);
      for (let i = 0; i < 20; i++) { cv.dispatchEvent(new PointerEvent("pointermove", { clientX: R.left + (x0 > n.W / 2 ? 30 : n.W - 30), clientY: R.top + n.floorY - 20, bubbles: true })); n.step(12); }
      const stayed = Math.abs(c.x - x0) < 4 * n.S;
      n.setChase(true);
      for (let i = 0; i < 40; i++) { cv.dispatchEvent(new PointerEvent("pointermove", { clientX: R.left + (x0 > n.W / 2 ? 30 : n.W - 30), clientY: R.top + n.floorY - 20, bubbles: true })); n.step(12); }
      return { blink: lidMax > 0.8 && lidMin < 0.05, stayed, chased: Math.abs(c.x - x0) > 40 * n.S };
    });
    check("쳐다보기·따라오기 스위치: 천천히 눈을 감았다 뜨고, setChase(false) 면 커서를 안 따라온다", `눈 깜빡 ${gz.blink} · 끔 제자리 ${gz.stayed} · 켬 따라옴 ${gz.chased}`, gz.blink && gz.stayed && gz.chased);
    check("겹치기: 잡혀도 음악은 이어진다", `잡힘 ${g.grabbed} · 곁들임 ${g.before}→${g.side}→${g.after}`, g.grabbed && g.before === "music" && g.side === "music" && g.after === "music");
    await p.close();
  }

  // 9-o) 소품을 놓는 활동을 뛰는 중에 시작해 멀리 내려도 소품을 고양이 앞에 다시 펴고, 머리가 소품까지 끌려가 목이 늘어나지 않는다
  //      (화면 모드에서 상자 뒤지기 중 고개가 뽑혀 몸이 길게 늘어나 보이던 것). 어떤 활동이든 머리는 목 기준점에서 50 안
  {
    const p = await open("?world=1&fixed=0.8", { width: 1200, height: 700 });
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, S = n.S, o = {};
      n.setGround(600); n.step(120);
      const reach = () => Math.hypot(c.headAnc[0] - c.headAnc0[0], c.headAnc[1] - c.headAnc0[1]) / S;
      for (const k of ["dig", "box", "snack", "typing"]) {
        n.act(null); n.step(240);
        n.walkTo(c.x + (c.x < n.W / 2 ? 300 : -300) * S); n.step(30); n.jump(); n.step(4); n.act(k);
        let mx = 0; for (let i = 0; i < 120 * 8; i++) { n.step(1); mx = Math.max(mx, reach()); }
        const prop = c.act && (c.act.box || c.act.bowl || c.act.lap);
        o[k] = { reach: +mx.toFixed(0), near: prop ? +(Math.abs(prop.x - c.x) / S).toFixed(0) : null };
      }
      return o;
    });
    const ok = Object.values(r).every((v) => v.reach <= 50 && v.near !== null && v.near < 110);
    check("뛰다 시작한 활동: 내린 자리에 소품을 다시 펴고 머리는 목에서 50 안", Object.entries(r).map(([k, v]) => `${k} 머리 ${v.reach}·소품 ${v.near}`).join(" · "), ok);
    await p.close();
  }

  // 9-q) 타이핑 쉼(setRest): 키를 안 누르고 글자가 안 늘며 가끔 깜빡인다. 끄면 다시 친다. 타이핑이 아니면 무시, 활동이 바뀌면 꺼진다
  {
    const p = await open(`?w=680&h=300&scale=height&transparent=1`, { width: 1000, height: 600 });
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat;
      n.setWander(false); n.act("typing"); n.step(240);
      const typed = () => c.act.lap.lines.reduce((a, l) => a + l.w, 0) + c.act.lap.lines.length * 100;
      n.setRest(true); n.step(30); const w0 = typed();
      let presses = 0, lidMax = 0;
      for (let i = 0; i < 120 * 8; i++) { n.step(1); if (c.act.lap.press.some((v) => v > 0.5)) presses++; lidMax = Math.max(lidMax, c.actP.lid ?? 0); }
      const rest = { still: typed() === w0, presses, blinked: lidMax > 0.8 };
      n.setRest(false); n.step(240); const resumed = typed() > w0;
      n.setRest(true); n.act("reading"); n.step(30); n.setRest(true); const ignored = c.act.rest === undefined;
      n.act("typing"); n.step(5); const fresh = !c.act.rest;
      return { ...rest, resumed, ignored, fresh };
    });
    check("타이핑 쉼: 키를 안 누르고 글자가 안 늘며 가끔 깜빡, 끄면 다시 친다, 다른 활동은 무시·새 활동은 꺼짐", JSON.stringify(r),
      r.still && r.presses === 0 && r.blinked && r.resumed && r.ignored && r.fresh);
    await p.close();
  }

  // 9-r) 채팅 낙서 선물(pictureGift): 큰 그림은 긴 변 256 으로 줄이고(투명 그대로), 아주 복잡하면 더 줄여 상한 안에.
  //      액자 안 그림은 엔진(방)과 선물 창(decor-draw) 모두 그린다 — 그림을 다 읽으면 onShapeImage 로 다시 그린다
  {
    const p = await open(`?w=680&h=300&scale=height`, { width: 1000, height: 600 }, 2);
    const r = await p.evaluate(async () => {
      const { shrinkPicture, pictureShape, PICTURE_BUDGET } = await import("/src/neko/pictureGift.ts");
      const { onShapeImage } = await import("/src/neko/engine/gift-shape.js");
      const dd = await import("/src/neko/engine/decor-draw.js");
      const big = document.createElement("canvas"); big.width = 1200; big.height = 800;
      const g = big.getContext("2d"); g.fillStyle = "#e0303a"; g.beginPath(); g.arc(600, 400, 300, 0, Math.PI * 2); g.fill();
      const a = await shrinkPicture(big.toDataURL("image/png"));
      const back = new Image(); back.src = a.url; await back.decode();
      const t = document.createElement("canvas"); t.width = a.w; t.height = a.h; const tg = t.getContext("2d"); tg.drawImage(back, 0, 0);
      const clear = tg.getImageData(0, 0, 1, 1).data[3] === 0, red = tg.getImageData(a.w >> 1, a.h >> 1, 1, 1).data;
      const noisy = document.createElement("canvas"); noisy.width = 1200; noisy.height = 800;
      const ng = noisy.getContext("2d"), px = ng.createImageData(1200, 800);
      for (let i = 0; i < px.data.length; i++) px.data[i] = (Math.random() * 256) | 0;
      ng.putImageData(px, 0, 0);
      const b = await shrinkPicture(noisy.toDataURL("image/png"));
      // 그림을 처음 보는 창: 읽기 전엔 매트만, 다 읽으면 알림 → 다시 그리면 그림이 보인다
      const shape = pictureShape(a.url + "", a.w, a.h);
      const items = [{ id: "pic", shape, size: "large", surface: "floor", u: 0.5 }];
      const cv = document.createElement("canvas"), view = { W: 400, H: 200, floorY: 180, scale: 1 };
      const redIn = () => { const [box] = dd.decorBoxes(items, view), d = cv.getContext("2d").getImageData(Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2), 1, 1).data; return d[0] > 180 && d[1] < 110; };
      const loaded = new Promise((ok) => { const off = onShapeImage(() => { off(); ok(true); }); setTimeout(() => ok(false), 3000); });
      dd.drawDecor(cv, items, view);
      const before = redIn();
      const notified = await loaded;
      dd.drawDecor(cv, items, view);
      const after = redIn();
      // 엔진(방)도 같은 모양으로
      const n = window.__neko; n.setWander(false); n.setDecor([{ id: "pic", shape, size: "large", surface: "wall", u: 0.3, v: 0.5 }]); n.step(30); n.draw();
      let engineRed = false;
      for (let y = 0; y < n.floorY && !engineRed; y += 2) for (let x = 0; x < n.W && !engineRed; x += 2) if (n.hitDecor(x, y) === "pic") {
        const cvs = document.getElementById("stage"), d = cvs.getContext("2d").getImageData(Math.round((x + 3) * 2), Math.round((y + 3) * 2), 1, 1).data; if (d[0] > 180 && d[1] < 110) engineRed = true;
      }
      return { first: { w: a.w, h: a.h, len: a.url.length, clear, red: red[0] > 200 && red[3] > 200 }, noisy: { w: b.w, len: b.len ?? b.url.length }, budget: PICTURE_BUDGET, before, notified, after, engineRed };
    });
    check("채팅 낙서 선물: 큰 그림은 긴 변 256 으로(투명 그대로), 복잡하면 더 줄여 상한 안", JSON.stringify({ ...r.first, noisy: r.noisy }),
      r.first.w === 256 && r.first.h <= 171 && r.first.len <= r.budget && r.first.clear && r.first.red && r.noisy.w < 256 && r.noisy.len <= r.budget);
    check("채팅 낙서 선물: 액자 안 그림 — 선물 창은 다 읽으면 알림 받고 다시 그려 보이고, 엔진(방)도 그린다", `알림 ${r.notified} · 다시 그림 ${r.after} · 엔진 ${r.engineRed}`, r.notified && r.after && r.engineRed);
    await p.close();
  }

  // 9-s) 벽 타는 중에 다른 활동이 오면(스케줄러 상한·승인 대기 등) 벽에서 사라지듯 내려오지 않고 뛰어내려 착지한 뒤 넘긴다.
  //      그동안 activity 는 climb, 같은 다음 활동이 또 와도 그대로. 걸어가는 중이면 바로 넘긴다. 한 번짜리는 maxMs 를 적었다
  {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(async () => {
      const { MIX } = await import("/src/neko/engine/activity-mix.js");
      const n = window.__neko, c = n.cat, o = {};
      n.setGround(830); n.step(120);
      const run = (next) => {
        n.act(null); n.step(240); c.x = n.W * 0.85; c.vx = 0; n.step(30);
        n.act("climb");
        for (let i = 0; i < 120 * 40 && !(c.act && c.act.phase === "cling" && c.y < n.floorY - 260 * n.S); i++) n.step(1);
        const high = c.act && c.act.phase === "cling", y0 = c.y;
        n.act(next); const still = n.activity === "climb"; n.act(next);
        let jump = 0, prev = c.y, f = 0, during = true;
        while (n.activity === "climb" && f < 120 * 10) { n.step(1); f++; jump = Math.max(jump, Math.abs(c.y - prev)); prev = c.y; if (n.activity === "climb" && c.mode === "idle" && f > 30) during = false; }
        return { high, still, after: n.activity, landed: Math.abs(c.y - (n.floorY - 0)) > 0 && c.mode !== "fall", sec: +(f / 120).toFixed(2), maxStep: +jump.toFixed(1), from: Math.round(n.floorY - y0) };
      };
      o.toWindow = run("window");
      o.toNull = run(null);
      // 걸어가는 중이면 바로
      n.act(null); n.step(240); c.x = n.W * 0.5; n.step(30); n.act("climb"); n.step(60); const walking = c.act.phase === "approach"; n.act("window");
      o.approach = { walking, now: n.activity };
      n.act(null);
      o.maxMs = ["stamp", "snack", "stretch", "erase", "climb"].map((k) => MIX[k].maxMs);
      return o;
    });
    const ok = (x, next) => x.high && x.still && x.after === next && x.maxStep < 40 && x.sec > 0.3;
    check("벽 타는 중 끊기면: 뛰어내려 착지한 뒤 넘긴다(그동안 climb, 한 프레임에 크게 안 튐), 걸어가는 중이면 바로", JSON.stringify(r),
      ok(r.toWindow, "window") && ok(r.toNull, null) && r.approach.walking && r.approach.now === "window" && r.maxMs.every((v) => v > 0));
    await p.close();
  }

  // 9-t) 캣타워 1단계(창 윗변 발판): 놓으면 발 아래 윗변에 내린다 · 윗변 안에서만 걷는다 · 창이 움직이면 같이 간다 ·
  //      흔들거나 창이 사라지면 떨어져 아래 윗변이나 바닥에 · 돌아다니는 놀이·다른 모니터로 가기는 먼저 뛰어내린다
  {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, o = {}, S = n.S;
      n.setGround(830); n.step(120);
      const top = (y = 500, x0 = 400, x1 = 1000, id = "7:0", win = 7) => ({ id, win, x0, x1, y });
      const feet = () => Math.max(...c.legs.map((L) => L.foot.y));
      const dropAt = (x, y) => { c.x = x; c.y = y; c.vx = 0; c.vy = 0; c.mode = "fall"; c.modeT = 0; for (let i = 0; i < 120 * 3; i++) n.step(1); };
      // 놓으면 윗변에
      n.setPerches({ tops: [top()], walls: [] });
      dropAt(700, 200);
      o.landed = { perch: n.perch, feet: Math.round(feet()), floor: n.floorY };
      // 윗변 안에서만 걷는다
      n.walkTo(5000); for (let i = 0; i < 120 * 12; i++) n.step(1);
      o.walk = { x: Math.round(c.x), max: Math.round(1000 - 36 * S), still: n.perch };
      // 창 크기만 바뀌면(끝 하나) 그대로 선다
      n.setPerches({ tops: [top(500, 400, 1060)], walls: [], partial: 7 }); n.step(30);
      const resized = n.perch;
      // 창을 옮기면(사용자 결정) 따라가지 않고 떨어져 바닥에
      n.setPerches({ tops: [top(500, 404, 1064)], walls: [], partial: 7 }); n.step(2);
      const fell = n.perch === null;
      for (let i = 0; i < 120 * 3; i++) n.step(1);
      o.move = { resized, fell, onFloor: Math.abs(n.floorY - 830) < 1 && c.mode !== "fall" && Math.abs(feet() - 830) < 8 };
      // 창이 사라지면 아래 윗변으로
      n.setPerches({ tops: [top(400, 300, 1100, "1:0", 1), top(650, 300, 1100, "2:0", 2)], walls: [] });
      dropAt(700, 150);
      const onHigh = n.perch;
      n.setPerches({ tops: [top(650, 300, 1100, "2:0", 2)], walls: [] }); for (let i = 0; i < 120 * 3; i++) n.step(1);
      o.under = { onHigh, now: n.perch };
      // 돌아다니는 놀이는 먼저 뛰어내린다
      n.act("yarn"); let hopped = false;
      for (let i = 0; i < 120 * 20 && n.activity !== "yarn"; i++) { n.step(1); if (!n.perch) hopped = true; }
      o.roam = { hopped, act: n.activity, floor: n.floorY };
      n.act(null); n.step(120);
      // 다른 모니터로 가기(walkOut)도 먼저 내려온다
      n.setPerches({ tops: [top(600, 300, 1100, "3:0", 3)], walls: [] }); dropAt(700, 300);
      const up = n.perch; n.walkOut("right"); for (let i = 0; i < 120 * 15 && n.perch; i++) n.step(1);
      o.out = { up, down: n.perch === null };
      n.setEdges({ left: false, right: false });
      return o;
    });
    check("캣타워: 놓으면 발 아래 창 윗변에 선다, 윗변 끝 안에서만 걷는다", JSON.stringify({ landed: r.landed, walk: r.walk }),
      r.landed.perch === "7:0" && r.landed.floor === 500 && Math.abs(r.landed.feet - 500) < 6 && r.walk.x <= r.walk.max + 1 && r.walk.still === "7:0");
    check("캣타워: 창 크기만 바뀌면 그대로, 창을 옮기면 따라가지 않고 떨어져 바닥에 착지", JSON.stringify(r.move),
      r.move.resized === "7:0" && r.move.fell && r.move.onFloor);
    check("캣타워: 올라탄 창이 사라지면 아래 창 윗변에, 공놀이·다른 모니터로 가기는 먼저 뛰어내린다", JSON.stringify({ under: r.under, roam: r.roam, out: r.out }),
      r.under.onHigh === "1:0" && r.under.now === "2:0" && r.roam.hopped && r.roam.act === "yarn" && r.roam.floor === 830 && r.out.up === "3:0" && r.out.down);
    await p.close();
  }

  // 9-u) 캣타워 2단계(창 탐험): 창 옆면을 타고 올라 윗변에 올라서고, 다른 창 윗변으로 뛰어 건넌다. 순간이동 없이(한 프레임 이동 작게).
  //      오르는 중에 다른 활동이 오면 뛰어내려 착지한 뒤 넘긴다. 갈 곳이 없으면(창 없음) 바로 끝난다
  {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, o = {};
      n.setGround(830); n.step(120);
      const perches = {
        tops: [{ id: "1:t0", win: 1, x0: 500, x1: 900, y: 560 }, { id: "2:t0", win: 2, x0: 950, x1: 1300, y: 480 }],
        walls: [{ id: "1:l0", win: 1, x: 500, y0: 560, y1: 830, face: "left" }, { id: "1:r0", win: 1, x: 900, y0: 560, y1: 830, face: "right" },
          { id: "2:l0", win: 2, x: 950, y0: 480, y1: 830, face: "left" }, { id: "2:r0", win: 2, x: 1300, y0: 480, y1: 830, face: "right" }],
      };
      n.setPerches({ tops: [], walls: [] }); n.act("tower"); n.step(5); o.none = n.activity;
      n.setPerches(perches); c.x = 300; c.vx = 0; n.step(60);
      o.ok = n.towerOk;
      n.act("tower");
      const seen = new Set(); let maxStep = 0, prev = [c.x, c.y], f = 0, climbed = false;
      for (; f < 120 * 90 && n.activity === "tower"; f++) {
        n.step(1);
        if (n.perch) seen.add(n.perch);
        if (c.act && c.act.phase === "cling") climbed = true;
        maxStep = Math.max(maxStep, Math.hypot(c.x - prev[0], c.y - prev[1])); prev = [c.x, c.y];
      }
      o.run = { seen: [...seen], climbed, maxStep: +maxStep.toFixed(1), sec: +(f / 120).toFixed(1), end: n.activity, perch: n.perch };
      // 오르는 중에 끊기
      n.act(null); n.step(10); n.setPerches({ tops: [], walls: [] }); for (let i = 0; i < 120 * 3; i++) n.step(1);
      n.setPerches(perches); c.x = 300; c.vx = 0; n.step(60);
      n.act("tower"); let cling = false;
      for (let i = 0; i < 120 * 30 && !cling; i++) { n.step(1); cling = !!(c.act && c.act.phase === "cling"); }
      n.act("window"); const held = n.activity;
      for (let i = 0; i < 120 * 5 && n.activity !== "window"; i++) n.step(1);
      o.cut = { cling, held, now: n.activity, perch: n.perch };
      n.act(null); n.step(240);
      // 떠 있는 창(옆면 아래 끝이 바닥에서 110px — 뛰어 잡는다)·화면만큼 높은 창도 간다. 너무 높이 뜬 창은 까닭을 알려 준다
      const visit = (pp) => {
        n.setPerches({ tops: [], walls: [] }); for (let i = 0; i < 120 * 3; i++) n.step(1);
        n.setPerches(pp); c.x = 300; c.vx = 0; n.step(60);
        const ok = n.towerOk; n.act("tower"); const seen = new Set();
        for (let i = 0; i < 120 * 60 && n.activity === "tower"; i++) { n.step(1); if (n.perch) seen.add(n.perch); }
        n.act(null); n.step(60); return { ok, seen: [...seen] };
      };
      const win = (w, x0, x1, y0, y1) => ({ tops: [{ id: w + ":t0", win: w, x0, x1, y: y0 }], walls: [{ id: w + ":l0", win: w, x: x0, y0, y1, face: "left" }, { id: w + ":r0", win: w, x: x1, y0, y1, face: "right" }] });
      o.floating = visit(win(3, 500, 760, 380, 720));
      o.tall = visit(win(4, 600, 1100, 80, 830));
      o.sticky = visit(win(6, 520, 573, 700, 748)); // 스티키 메모(53×48): 몸보다 짧아도 가운데에 올라앉는다
      n.setPerches(win(5, 500, 760, 200, 560)); c.x = 300; n.step(30);
      o.why = n.towerWhy();
      return o;
    });
    check("창 탐험: 창 옆면을 타고 올라 윗변에 서고 다른 창으로 건너간다(순간이동 없이), 창이 없으면 바로 끝", JSON.stringify(r),
      r.none === null && r.ok && r.run.climbed && r.run.seen.includes("1:t0") && r.run.maxStep < 30 && r.run.end === null);
    check("창 탐험: 오르는 중 다른 활동이 오면 뛰어내려 착지한 뒤 넘긴다", JSON.stringify(r.cut), r.cut.cling && r.cut.held === "tower" && r.cut.now === "window" && r.cut.perch === null);
    check("창 탐험: 떠 있는 창(옆면 끝을 뛰어 잡음)·화면만큼 높은 창도 오르고, 못 가는 창은 까닭(towerWhy)", JSON.stringify({ floating: r.floating, tall: r.tall, sticky: r.sticky, why: r.why }),
      r.floating.ok && r.floating.seen.includes("3:t0") && r.tall.ok && r.tall.seen.includes("4:t0") && r.sticky.seen.includes("6:t0") && r.why.length === 1 && !r.why[0].ok && /떠 있다/.test(r.why[0].why));
    await p.close();
  }

  // 9-p) 벽 타기: 자리 높이에 맞춰 오른다(귀 끝이 천장의 70~85%, 낮은 방은 예전처럼, 마당은 고양이 키의 4~5배까지).
  //      천장·벽에 건 선물에 닿지 않고, 성공(두리번 → 뛰어내림)·실패(미끄러짐) 모두 끝난다
  {
    const climb = async (q, vp, o = {}) => {
      const p = await open(q, vp);
      const r = await p.evaluate((o) => {
        const n = window.__neko, c = n.cat, S = n.S, H2W = n.debug.H2W;
        if (o.ground) n.setGround(o.ground);
        n.step(60);
        let giftBottom = null;
        if (o.gift) { // 오를 벽(가까운 쪽)에 큰 선물을 높이 건다
          const right = c.x > n.W / 2, gx = right ? n.W - 16 * S : 16 * S;
          n.setDecor([{ id: "w", surface: "wall", u: right ? 1 : 0, v: o.gift, size: "large", shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] } }]); n.step(200); n.draw();
          for (let y = 0; y < n.floorY; y++) if (n.hitDecor(gx, y)) giftBottom = y;
        }
        n.act("climb"); const A = c.act, side = A.side, giftSide = c.x > n.W / 2 ? 1 : -1;
        if (o.win != null) { const plan = A; const iv = () => { if (plan.T != null && !plan.__set) { plan.__set = true; plan.win = o.win; plan.hold = o.win ? 2.4 : plan.hold; plan.tSlide = plan.tTop + plan.hold; plan.tFall = plan.tSlide + plan.slideT; } }; o.iv = iv; }
        let top = Infinity, minY = Infinity, ended = false;
        for (let i = 0; i < 120 * 40; i++) {
          n.step(1); if (o.iv) o.iv();
          if (!c.act) { ended = true; break; }
          top = Math.min(top, ...[[-28, -46], [28, -46]].map(([x, y]) => H2W(x, y)[1])); minY = Math.min(minY, c.y);
        }
        return { h: (n.floorY - minY) / S, frac: (n.floorY - top) / n.floorY, topPx: top, S, ended, giftBottom, sameWall: side === giftSide };
      }, o);
      await p.close();
      return r;
    };
    const low = await climb("?w=704&h=282&scale=height", { width: 760, height: 1000 });
    const tall = await climb("?w=1200&h=760&scale=height", { width: 1300, height: 900 });
    const yard = await climb("?world=1&fixed=0.8", { width: 1400, height: 900 }, { ground: 860 });
    const win = await climb("?w=1200&h=760&scale=height", { width: 1300, height: 900 }, { win: true });
    const gift = await climb("?w=1200&h=760&scale=height", { width: 1300, height: 900 }, { gift: 0.8 });    // 높이 건 것: 그 아래까지
    const block = await climb("?w=1200&h=760&scale=height", { width: 1300, height: 900 }, { gift: 0.45 }); // 낮게 건 것: 반대쪽 벽으로
    check("벽 타기: 자리 높이에 맞춰 오른다(낮은 방은 그대로, 높은 방 70~85%, 마당은 상한)",
      `낮은 방 ${low.h.toFixed(0)}단위·천장 여유 ${low.topPx.toFixed(0)}px · 높은 방 ${(tall.frac * 100).toFixed(0)}% · 마당 ${yard.h.toFixed(0)}단위`,
      low.h >= 115 && low.h <= 125 && low.topPx >= 4 && tall.frac >= 0.68 && tall.frac <= 0.87 && yard.h > 300 && yard.h <= 500 && low.ended && tall.ended && yard.ended);
    check("벽 타기: 성공하면 두리번거리다 뛰어내리고 끝난다", `끝남 ${win.ended} · 높이 ${win.h.toFixed(0)}`, win.ended && win.h > 150);
    check("벽 타기: 벽에 건 선물 아래까지만 오르고, 낮게 막혔으면 반대쪽 벽으로", `선물 아래 ${gift.giftBottom?.toFixed(0)}px · 귀 끝 ${gift.topPx.toFixed(0)}px · 같은 벽 ${gift.sameWall} · 낮게 막힘 → 반대쪽 ${!block.sameWall}`,
      gift.giftBottom != null && gift.sameWall && gift.topPx >= gift.giftBottom && gift.ended && !block.sameWall && block.ended);
  }

  // 9-b) 점프: 말랑함이 커도(뛸 때 몸이 더 늘어남) 귀 끝이 낮은 무대 천장에 닿지 않는다
  for (const [w, h] of [[704, 282], [220, 150], [900, 150]]) {
    const p = await open(`?w=${w}&h=${h}&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(() => {
      const n = window.__neko, cv = document.getElementById("stage"), g = cv.getContext("2d"), out = {};
      n.setWander(false);
      for (const soft of [0, 0.6, 1]) {
        n.setAppearance({ soft }); n.step(240); let worst = 99;
        for (let j = 0; j < 4; j++) {
          n.jump();
          for (let i = 0; i < 160; i++) { n.step(1); if (i % 3) continue; n.draw();
            const W = cv.width, d = g.getImageData(0, 0, W, 12).data;
            for (let y = 0; y < 12 && y < worst; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 40) { worst = y; break; } }
          n.step(120);
        }
        out[soft] = worst;
      }
      return out;
    });
    check(`점프 ${w}×${h}: 천장까지 여유(px, 말랑함 0/0.6/1)`, [0, 0.6, 1].map((k) => (r[k] === 99 ? "12+" : r[k])).join(" / "), Object.values(r).every((v) => v >= 2));
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

  // 10-b) 말랑함: 콕 눌렀을 때 출렁임 크기·길이가 값을 따라 확실히 달라진다(0 < 0.6 < 1)
  {
    const p = await open();
    const r = await p.evaluate(() => {
      const n = window.__neko, out = {};
      n.setWander(false);
      for (const soft of [0, 0.6, 1]) {
        n.setAppearance({ soft }); n.setPose("stand"); n.step(240);
        const belly = () => Math.max(...n.debug.bodyWorld().map((q) => q[1]));
        const rest = belly();
        n.boing(1);
        let peak = 0, frames = 0;
        for (let f = 1; f <= 240; f++) { n.step(1); const d = Math.abs(belly() - rest) / n.S; peak = Math.max(peak, d); if (d > 0.6) frames = f; }
        out[soft] = { peak, frames };
      }
      return out;
    });
    const ok = r[0].peak < r[0.6].peak && r[0.6].peak < r[1].peak && r[1].peak > 8 && r[1].peak > 4 * r[0].peak && r[1].frames > 3 * Math.max(1, r[0].frames);
    check("말랑함: 콕 눌림 출렁임 0 < 0.6 < 1", [0, 0.6, 1].map((k) => `${k}: ${r[k].peak.toFixed(1)}단위/${r[k].frames}f`).join(" · "), ok);
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
