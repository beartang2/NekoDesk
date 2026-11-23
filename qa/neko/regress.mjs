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
      n.setDecor([{ id: "g", surface: "floor", u: 0.1, size: "small", scale: 0.5, frame: true, shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] } }]); // 가장 작게(한 변 29), 액자(액자만 벽에 건다)
      n.step(90); n.draw();
      const boxOf = () => { for (let y = 0; y < n.floorY; y += 2) for (let x = 0; x < n.W; x += 2) if (n.hitDecor(x, y)) return [x, y]; return null; };
      const at = boxOf(), R = rect(), fire = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { clientX: R.left + x, clientY: R.top + y, pointerId: 7, bubbles: true, button: extra.button ?? 0 }));
      const [x0, y0] = [at[0] + 4, at[1] + 4];
      fire("pointerdown", x0, y0); fire("pointermove", x0 + 40, y0 - 90); fire("pointerup", x0 + 40, y0 - 90);
      const moved = ev[0] && ev[0][1];
      n.setDecor([{ id: "g", size: "small", scale: 0.5, frame: true, shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] }, ...moved }]); n.step(60); n.draw();
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

  // 9-f2) 터치로 꾹 누르기(iOS 웹뷰엔 contextmenu 가 안 온다): 0.5초 가만히 누르면 끌기를 접고 '정리' 메뉴(decorMove 없음),
  //       누르는 중 8px 넘게 움직이면 그냥 끌기(decorMove, 메뉴 없음). 마우스는 오래 눌러도 메뉴가 안 뜬다
  {
    const p = await open(`?w=320&h=240&scale=height&transparent=1`, { width: 1000, height: 600 }, 1);
    const r = await p.evaluate(async () => {
      const n = window.__neko, cv = document.getElementById("stage"), ev = [];
      n.on("decorMove", (e) => ev.push("move")); n.on("decorMenu", (e) => ev.push("menu"));
      n.setWander(false); n.cat.x = n.W * 0.8; n.step(60);
      n.setDecor([{ id: "g", surface: "floor", u: 0.1, size: "small", scale: 0.5, shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "red" }] } }]);
      n.step(90); n.draw();
      const boxOf = () => { for (let y = 0; y < n.floorY; y += 2) for (let x = 0; x < n.W; x += 2) if (n.hitDecor(x, y)) return [x, y]; return null; };
      const R = cv.getBoundingClientRect(), [x0, y0] = boxOf().map((v) => v + 4), wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const fire = (type, pointerType, dx = 0, dy = 0) => cv.dispatchEvent(new PointerEvent(type, { clientX: R.left + x0 + dx, clientY: R.top + y0 + dy, pointerId: 9, pointerType, bubbles: true }));
      const run = async (pointerType, dx) => {
        ev.length = 0;
        fire("pointerdown", pointerType); fire("pointermove", pointerType, dx, 0); await wait(650);
        fire("pointerup", pointerType, dx, 0); await wait(30);
        return ev.join(",");
      };
      // 끌기는 물건을 옮기므로 맨 끝에
      const hold = await run("touch", 3), mouse = await run("mouse", 3), drag = await run("touch", 30);
      return { hold, mouse, drag };
    });
    check("놓아 둔 선물: 터치로 꾹 누르면 정리 메뉴, 움직이면 끌기, 마우스는 오래 눌러도 메뉴 없음",
      `꾹 ${r.hold || "-"} · 끌기 ${r.drag || "-"} · 마우스 ${r.mouse || "-"}`, r.hold === "menu" && r.drag === "move" && r.mouse === "move");
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
        n.setDecor([{ id: "g", surface, u: 0.25, v: 0.5, play, size: play === "sit_on" ? undefined : "small", scale: 0.5, shape: play === "sit_on" ? shapes.flat : shapes.round }]); // 굴리고 물 만한 크기(가장 작게)
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
    check("선물 크기: small < medium < large, 기본 한 변 96 — medium 이 몸길이쯤", `폭 ${r.s.toFixed(0)} · ${r.m.toFixed(0)} · ${r.l.toFixed(0)} (몸 ${r.body.toFixed(0)})`, r.s < r.m && r.m < r.l && r.m > 0.8 * r.body && r.m < 1.1 * r.body);
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
      // 한 판은 물건 둘과 놀고 끝난다(한 번짜리) — 끝나면 다시 시켜 셋째를 본다
      for (let i = 0; i < 120 * 60 && played.length < 4; i++) { if (!c.act) n.act("giftplay"); n.step(1); }
      const rotation = played.slice(0, 3).sort().join(""), plays = {};
      n.act(null); n.step(30);
      for (const [size, play] of [["large", "carry"], ["large", "roll"], ["large", "lean"], ["large", "hide"], ["large", "scratch"], ["small", "scratch"]]) {
        n.setDecor([{ id: size + play, surface: "floor", u: 0.3, size, play, shape, ...(size === "small" ? { scale: 0.5 } : {}) }]); // 작은 것 = 가장 작게(한 변 29)
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
    check("선물 배율: 놀이는 종류 × 배율로(중간×2 는 큰 물건 놀이, 작은×0.5 기대기는 냄새, 중간×3 위에 앉기는 기대기, 작은×0.5 굴리기 그대로)", JSON.stringify(r.scaled),
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
      n.setDecor([{ id: "g", surface: "floor", u: 0.45, play: "roll", size: "small", scale: 0.5, shape }]); n.step(10);
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
      n.setDecor([{ id: "u", surface: "floor", u: 0.45, play: "roll", size: "small", scale: 0.5, shape }]); n.step(10);
      n.act("giftplay");
      let rolling = false;
      for (let i = 0; i < 120 * 30 && !rolling; i++) { n.step(1); rolling = c.act && c.act.stage === "rolling"; }
      moves.length = 0;
      n.setDecor([{ id: "u", surface: "floor", u: 0.9, play: "roll", size: "small", scale: 0.5, shape }]);
      n.act(null); n.step(30);
      const userWins = { rolling, overwritten: moves.some((u) => u !== 0.9) };
      // 물고 옮기다 목록에서 빠짐(다른 모니터로 건너감 등): 잡은 목록과 입에서 빠진다
      n.setDecor([{ id: "m", surface: "floor", u: 0.45, play: "carry", size: "small", scale: 0.5, shape }]); n.step(10);
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

  // 9-t2) 활동이 갑자기 끊길 때 팔(사용자: 창 위 활동 중 창을 옮기면 떨어지며 팔이 튀어나가 늘어남). 다리 길이 = 엉덩이~발 / 제 길이.
  //       창이 움직여 떨어짐·다른 모니터로 옮김(shiftWorld)·act(null)·앉은 채 잡아 들기
  {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, S = n.S, o = { fall: {}, stop: {} };
      n.setGround(830); n.step(120);
      const legLen = () => Math.max(...c.legs.map((L) => Math.hypot(L.footW[0] - L.hipW[0], L.footW[1] - L.hipW[1]) / ((L.def.a + L.def.b) * c.ll.len * S)));
      const watch = (sec) => { let len = 0, jump = 0, prev = c.legs.map((L) => [...L.footW]);
        for (let i = 0; i < 120 * sec; i++) { n.step(1); len = Math.max(len, legLen()); c.legs.forEach((L, j) => { jump = Math.max(jump, Math.hypot(L.footW[0] - prev[j][0], L.footW[1] - prev[j][1]) / S); prev[j] = [...L.footW]; }); }
        return { len: +len.toFixed(2), jump: +jump.toFixed(1) }; };
      for (const key of ["draw", "typing", "groom"]) {
        n.act(null); n.setPerches({ tops: [{ id: "7:0", win: 7, x0: 300, x1: 1100, y: 500 }], walls: [] });
        c.x = 700; c.y = 300; c.vx = 0; c.vy = 0; c.mode = "fall"; c.modeT = 0; n.step(240);
        n.act(key); n.step(300);
        const on = n.perch === "7:0" && n.activity === key;
        n.setPerches({ tops: [{ id: "7:0", win: 7, x0: 320, x1: 1120, y: 520 }], walls: [], partial: 7 }); // 창을 옮겼다
        o.fall[key] = { on, ...watch(2), act: n.activity };
        n.setPerches({ tops: [], walls: [] }); n.act(null); n.step(120);
        n.act(key); n.step(360); n.act(null); o.stop[key] = watch(1);
      }
      c.x = 700; n.step(120); n.act("draw"); n.step(300);
      n.shiftWorld(-600, 60, 760); n.setEdges({ left: false, right: false });
      o.shift = watch(2);
      n.act(null); n.shiftWorld(600, -60, 830); n.step(120);
      return o;
    });
    // 앉아서 활동하다 잡혀 들림: 앞발이 저 아래 바닥까지 늘어나지 않는다
    await p.evaluate(() => { const n = window.__neko, c = n.cat, S = n.S; window.__len = 0; c.x = 700; n.step(120); n.act("typing"); n.step(300);
      const st = n.step; n.step = (k) => { for (let i = 0; i < k; i++) { st(1); for (const L of c.legs) window.__len = Math.max(window.__len, Math.hypot(L.footW[0] - L.hipW[0], L.footW[1] - L.hipW[1]) / ((L.def.a + L.def.b) * c.ll.len * S)); } }; });
    const h = await p.evaluate(() => [window.__neko.cat.head.x, window.__neko.cat.head.y]);
    await p.mouse.move(h[0], h[1]); await p.mouse.down();
    for (let k = 1; k <= 8; k++) { await p.mouse.move(h[0], h[1] - 30 * k, { steps: 2 }); await p.evaluate(() => window.__neko.step(6)); }
    await p.evaluate(() => window.__neko.step(60)); await p.mouse.up(); await p.evaluate(() => window.__neko.step(240));
    r.grab = +(await p.evaluate(() => window.__len)).toFixed(2);
    const fallOk = Object.values(r.fall).every((f) => f.on && f.act === null && f.len <= 1.15 && f.jump <= 15);
    check("활동이 갑자기 끊겨도 팔이 늘거나 튀지 않는다: 창 위 활동 중 창이 움직여 떨어짐·모니터 옮김·활동 끝냄·앉은 채 잡혀 들림", JSON.stringify(r),
      fallOk && Object.values(r.stop).every((s) => s.jump <= 8) && r.shift.len <= 1.15 && r.grab <= 1.15);
    await p.close();
  }

  // 9-t3) 토라짐(react "sulk"): 마당에서 못 받는 걸(디스크·2GB 넘는 폴더) 입 앞에 놓으면 고개째 반대쪽으로 돌아서고 짜증 얼굴(사용자: 거절이 한눈에).
  //       커서가 멀면(채팅 중 도구 오류) 얼굴만, 하던 활동 중엔 돌아서지 않는다
  {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, o = {};
      n.setGround(830); c.x = 700; n.step(240);
      const f0 = c.face; n.react("sulk"); n.step(60); o.far = { turned: c.face !== f0, sulk: c.petSulk > 0 }; // 커서를 본 적 없음
      n.step(120 * 3);
      const m = () => [c.head.x + c.face * 20 * n.S, c.head.y + 12 * n.S];
      n.act("typing"); n.step(300); const f1 = c.face; n.fileDrag(m()); n.fileDrag(null); n.act("typing"); n.step(240);
      n.react("sulk"); n.step(60); o.busy = { turned: c.face !== f1, act: n.activity };
      n.act(null); n.step(120 * 3);
      for (let i = 0; i < 120 * 2; i++) { n.fileDrag(m()); n.step(1); } // 입 앞으로 끌고 와
      const f2 = c.face; n.fileDrag(null); n.react("sulk"); n.step(60); // 못 받았다
      o.drop = { turned: c.face === -f2, sulk: c.petSulk > 0, mode: c.mode };
      return o;
    });
    check("토라짐: 입 앞에 놓은 걸 못 받으면 고개째 돌아서고 짜증 얼굴, 커서가 멀거나 활동 중이면 돌아서지 않는다", JSON.stringify(r),
      r.drop.turned && r.drop.sulk && !r.far.turned && r.far.sulk && !r.busy.turned && r.busy.act === "typing");
    await p.close();
  }

  // 9-t4) 꿈(0.1.25): 누워 깊이 잘 때만 꿈 말풍선, 7초쯤 머물다 접힌다, 깨면 바로 접힌다. 방·화면 모드 둘 다(말풍선이 실제로 그려지는지 화소로)
  for (const world of [false, true]) {
    const p = world ? await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }) : await open();
    p.on("pageerror", (e) => errors.push(String(e)));
    if (world) { await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`); await p.waitForFunction(() => window.__nekoReady === true); await p.click("#wander"); }
    const r = await p.evaluate((world) => {
      const n = window.__neko, c = n.cat, cv = document.querySelector("canvas"), g = cv.getContext("2d"), k = cv.width / cv.getBoundingClientRect().width, o = {};
      if (world) { n.setGround(830); c.x = 700; }
      n.step(120);
      const content = { shape: { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] } };
      o.awake = n.dream(content);
      n.setPose("lie"); for (let i = 0; i < 120 * 4 && c.mode !== "lie"; i++) n.step(1); n.step(120);
      // 머리 위(귀 끝보다 위) 칸만 본다 — 숨쉬기로 바뀌는 몸 화소는 빼고
      const box = () => { const S = n.S, ox = world ? n.region?.x ?? 0 : 0, oy = world ? n.region?.y ?? 0 : 0; return [c.head.x - 150 * S - ox, c.head.y - 160 * S - oy, 300 * S, 110 * S].map((v) => Math.round(v * k)); };
      const snap = () => { n.draw(); const [x, y, w, hh] = box(); return g.getImageData(Math.max(0, x), Math.max(0, y), w, hh).data; };
      const diff = (a, b) => { let m = 0; for (let j = 0; j < a.length; j += 4) if (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]) + Math.abs(a[j + 3] - b[j + 3]) > 40) m++; return m; };
      const s0 = snap(); n.step(120); const s1 = snap(); o.still = diff(s0, s1); // 꿈 없이 1초(숨쉬기만)
      o.shown = n.dream(content); n.step(120); o.during = n.dreaming; o.ink = diff(s1, snap());
      n.step(120 * 8); o.after = n.dreaming;
      n.dream(content); n.step(60); n.setPose("stand"); for (let i = 0; i < 120 * 2 && n.dreaming; i++) n.step(1); o.wokeClosed = !n.dreaming;
      return o;
    }, world);
    check(`꿈: 누워 깊이 잘 때만 말풍선, 머물다 접히고 깨면 접힌다(${world ? "화면 모드" : "방"})`, JSON.stringify(r),
      r.awake === false && r.shown === true && r.during && r.ink > 300 && r.still < 50 && !r.after && r.wokeClosed);
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

  // 9-v) 올라탄 창을 옮겨 떨어질 때(사용자): 하던 활동은 정리(소품 쏙)하고 착지 뒤 다시 잇지 않는다, 곁들임 헤드폰은 낀 채,
  //      떨어지는 동안·착지 뒤 목·다리가 안 늘고 발이 바닥 아래로 안 가며 값이 깨지지 않는다
  {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base}/qa/neko/harness.html?world=1&fixed=0.8`);
    await p.waitForFunction(() => window.__nekoReady === true);
    await p.click("#wander");
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, S = n.S, out = {};
      n.setGround(830); n.step(120);
      const top = (x0) => ({ id: "9:t0", win: 9, x0, x1: x0 + 600, y: 520 });
      const feet = () => Math.max(...c.legs.map((L) => L.foot.y));
      const reach = () => Math.hypot(c.head.x - c.headAnc[0], c.head.y - c.headAnc[1]) / S; // 머리가 목 자리에서 늘어난 만큼
      const legMax = () => Math.max(...c.legs.map((L) => Math.hypot(L.foot.x - c.x, L.foot.y - c.y))) / S;
      const cases = [["pose", "sit"], ["pose", "loaf"], ["pose", "lie"], ["act", "groom"], ["act", "typing"], ["act", "box"], ["act", "reading"], ["act", "snack"], ["act", "knead"], ["side", "music"], ["tower", "walk"]];
      for (const [kind, k] of cases) {
        n.act(null); n.mix(null); n.setPose("stand"); n.step(60);
        n.setPerches({ tops: [top(400)], walls: [] }); c.x = 700; c.y = 300; c.vx = 0; c.vy = 0; c.mode = "fall"; c.modeT = 0; n.step(360);
        if (kind === "pose") n.setPose(k); else if (kind === "act") n.act(k); else if (kind === "side") n.mix(k);
        else { n.setPerches({ tops: [top(400), { id: "8:t0", win: 8, x0: 1100, x1: 1400, y: 450 }], walls: [] }); n.act("tower"); }
        let walking = false;
        for (let i = 0; i < 120 * 3 && !(kind === "tower" && (walking = c.mode === "walk")); i++) n.step(1);
        const before = { act: n.activity, props: c.act ? c.act.props.length : 0, perch: n.perch };
        n.setPerches({ tops: [top(440)], walls: [], partial: 9 }); // 사용자가 창을 옮겼다
        const at = { act: n.activity, side: n.side };
        let bad = false, neck = 0, leg = 0, below = 0, restarted = false;
        for (let i = 0; i < 120 * 4; i++) {
          n.step(1); if (i % 4 === 0) n.draw();
          if (![c.x, c.y, c.head.x, c.head.y].every(Number.isFinite)) bad = true;
          neck = Math.max(neck, reach()); leg = Math.max(leg, legMax()); below = Math.max(below, feet() - n.floorY);
          if (n.activity) restarted = true;
        }
        out[`${kind}:${k}`] = { before, at, after: { act: n.activity, side: n.side, perch: n.perch, floor: n.floorY, mode: c.mode, left: n.leftovers },
          walking: kind === "tower" ? walking : undefined, bad, restarted, neck: +neck.toFixed(0), leg: +leg.toFixed(0), below: +below.toFixed(1) };
      }
      n.mix(null); n.setPose("stand");
      return out;
    });
    const fails = Object.entries(r).filter(([k, v]) => {
      const side = k === "side:music";
      return !(v.before.perch === "9:t0" && v.at.act === null && !v.restarted && v.after.perch === null && v.after.floor === 830 && v.after.mode !== "fall"
        && v.after.left === 0 && !v.bad && v.neck <= 30 && v.leg <= 110 && v.below < 3 && (side ? v.after.side === "music" : true) && (k === "tower:walk" ? v.walking : true));
    });
    check("창을 옮겨 떨어질 때: 앉기·식빵·눕기·세수·타이핑·상자·신문·간식·꾹꾹이·음악·창 탐험 걷기 — 활동 정리·착지 뒤 안 이어짐·헤드폰 그대로·목·다리 안 늘어남",
      fails.length ? JSON.stringify(Object.fromEntries(fails)) : Object.entries(r).map(([k, v]) => `${k}${v.before.props ? `(소품 ${v.before.props})` : ""} 목${v.neck}·다리${v.leg}`).join(" · "), fails.length === 0);
    await p.close();
  }

  // 9-w) 프레임 정책(docs/neko-perf.md §3): 기본 30fps, 졸 때 15, 잡고 끌 때 60, 멈추면 한 프레임도 안 돈다, 상한 0 이면 화면 주사율
  {
    const p = await open(`?w=680&h=300&scale=height`, { width: 1000, height: 600 });
    const rate = (ms) => p.evaluate((ms) => new Promise((ok) => { const n = window.__neko, f0 = n.frames, t0 = performance.now(); setTimeout(() => ok(((n.frames - f0) * 1000) / (performance.now() - t0)), ms); }), ms);
    await p.evaluate(() => { window.__neko.setWander(false); window.__neko.setMood("idle"); });
    const awake = await rate(1500);
    await p.evaluate(() => window.__neko.setMood("sleepy"));
    const sleepy = await rate(1500);
    await p.evaluate(() => { window.__neko.setMood("idle"); window.__neko.pause(); });
    const paused = await rate(800);
    await p.evaluate(() => { window.__neko.resume(); window.__neko.setMaxFps(0); });
    const free = await rate(1500);
    await p.evaluate(() => window.__neko.setMaxFps(30));
    const box = await p.locator("#stage").boundingBox(), h = await p.evaluate(() => [window.__neko.cat.head.x, window.__neko.cat.head.y]);
    await p.mouse.move(box.x + h[0], box.y + h[1]); await p.mouse.down(); await p.mouse.move(box.x + h[0] + 10, box.y + h[1] - 40, { steps: 3 });
    const held = await rate(1000);
    await p.mouse.up();
    const r = { awake: Math.round(awake), sleepy: Math.round(sleepy), paused: Math.round(paused), free: Math.round(free), held: Math.round(held) };
    check("프레임: 기본 30·졸 때 15·잡고 끌 때 60·멈추면 0·상한 0 이면 화면 주사율", JSON.stringify(r),
      Math.abs(r.awake - 30) <= 4 && Math.abs(r.sleepy - 15) <= 3 && r.paused === 0 && r.free >= 50 && r.held >= 50);
    await p.close();
  }

  // 9-x) 창밖 구경: 방·거실은 벽의 날씨 창문(room-window.js) 아래로 걸어가 창을 보고 앉아 올려다본다. 커튼이 닫혀 있으면
  //      앞발을 위로 뻗어 톡톡. 창 자리가 바뀌면 하던 구경을 접는다. 자리 정보가 없으면 예전처럼 앞에 창을 그린다
  {
    const look = async (q, vp, place, left) => {
      const p = await open(q, vp);
      const r = await p.evaluate(({ place, left }) => {
        const n = window.__neko, c = n.cat, S = n.S;
        n.setWander(false); n.setMood("idle");
        n.setRoomWindow(place, true);
        c.x = left ? 60 * S : n.W - 60 * S;
        n.act("window"); n.step(120 * 8);
        const out = { mode: c.mode, act: n.activity, x: c.x, face: c.face, floorY: n.floorY, S, W: n.W, H: n.H };
        n.setRoomWindow(place, false);
        let up = Infinity;
        for (let s = 0; s < 120 * 5; s++) { n.step(1); up = Math.min(up, c.legs[3].footW[1]); }
        out.pawUp = up; out.closedMode = c.mode;
        n.setRoomWindow(place === "dock" ? "sidebar" : "dock", true);
        out.after = n.activity;
        return out;
      }, { place, left });
      await p.close();
      return r;
    };
    const { roomWindows } = await import("../../src/neko/engine/room-window.js");
    // 방은 창 하나(오른쪽 끝에서 걸어간다), 거실은 둘: 고양이와 가까운 창으로
    const DOCK = ["?w=900&h=130&scale=height", { width: 1100, height: 400 }];
    for (const [place, q, vp, left, wi] of [["sidebar", "?w=280&h=300&scale=height", { width: 600, height: 600 }, false, 0], ["dock", ...DOCK, true, 0], ["dock", ...DOCK, false, 1]]) {
      const r = await look(q, vp, place, left), win = roomWindows(place, r.W, r.H)[wi], cx = win.x + win.w / 2;
      check(`창밖 구경(${place}${left ? " 왼쪽" : " 오른쪽"}에서): 창 아래로 가서 창 쪽을 보고 앉고, 닫히면 앞발을 들고, 자리가 바뀌면 접는다`,
        JSON.stringify({ x: Math.round(r.x), cx, face: r.face, mode: r.mode, pawUp: Math.round(r.floorY - r.pawUp), after: r.after }),
        r.act === "window" && r.mode === "act" && Math.abs(r.x - cx) <= win.w && // 방 창은 왼쪽 벽 가까이라 걸을 수 있는 끝(EDGE)에 앉는다
           Math.sign(cx - r.x) === r.face &&
          r.closedMode === "act" && r.pawUp < r.floorY - 30 * r.S && r.after === null);
    }
  }

  // 9-y) 선물 놀이(0.1.19): 작은 선물은 기본 배율에서도 물고 옮기고 굴린다(그려지는 크기가 아니라 종류로 — 폰 세로·가로 같게),
  //      한 판은 물건 둘과 놀고 스스로 끝낸다(감독이 다른 놀이와 번갈아), 기운이 없으면 움직이는 놀이 대신 냄새 맡기
  {
    const run = async (q, vp) => {
      const p = await open(q, vp, 1);
      const r = await p.evaluate(() => {
        const n = window.__neko, c = n.cat, shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
        n.setWander(false);
        const chose = {};
        for (const play of ["carry", "roll"]) {
          n.setDecor([{ id: "s" + play, surface: "floor", u: 0.3, size: "small", play, shape }]);
          n.act("giftplay"); n.step(1); chose[play] = c.act && c.act.play;
          let carried = false, moved = false; const off = n.on("decorMove", () => { moved = true; });
          for (let i = 0; i < 120 * 25 && c.act; i++) { n.step(1); if (n.carried().length) carried = true; }
          off(); chose[play + "Did"] = play === "carry" ? carried : moved; n.act(null); n.step(30);
        }
        n.setNeeds({ energy: 20 });
        n.setDecor([{ id: "t", surface: "floor", u: 0.3, size: "small", play: "carry", shape }]);
        n.act("giftplay"); n.step(1); chose.tired = c.act && c.act.play; n.act(null); n.step(10);
        n.setNeeds({ energy: 70 });
        const played = []; const off = n.on("decorPlayed", (e) => played.push(e.id));
        n.setDecor(["a", "b", "c"].map((id, i) => ({ id, surface: "floor", u: 0.15 + i * 0.35, play: "sniff", shape })));
        n.act("giftplay");
        let t = 0; for (; t < 120 * 70 && n.activity === "giftplay"; t++) n.step(1);
        off();
        return { ...chose, rounds: played.length, ended: n.activity === null, sec: Math.round(t / 120) };
      });
      await p.close();
      return r;
    };
    for (const [name, q, vp] of [["폰 세로", "?w=375&h=120&scale=height", { width: 500, height: 300 }], ["폰 가로", "?w=724&h=340&scale=height", { width: 900, height: 500 }], ["맥 방", "?w=280&h=200&scale=height", { width: 500, height: 400 }]]) {
      const r = await run(q, vp);
      check(`선물 놀이(${name}): 작은 선물은 기본 배율에서 물고·굴리고, 한 판은 둘과 놀고 끝, 지치면 냄새`, JSON.stringify(r),
        r.carry === "carry" && r.carryDid && r.roll === "roll" && r.rollDid && r.tired === "sniff" && r.rounds === 2 && r.ended && r.sec < 60);
    }
  }

  // 9-z) 무대가 바뀌면 다시 편다(폰 가로↔세로·방↔거실·방 높이): 그리던 이젤·붓은 새 자리·새 배율로(그림은 이어서),
  //      다른 활동은 새 무대에서 처음부터, 옛 음표·말풍선은 지운다, 고양이는 바닥 선물을 덮지 않는다. 빠르게 여러 번 돌려도 된다
  {
    const p = await open(`?w=280&h=200&scale=height`, { width: 1000, height: 600 });
    const r = await p.evaluate(async () => {
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage");
      const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const size = (w, h) => { cv.style.width = w + "px"; cv.style.height = h + "px"; n.resize(); };
      n.pause(); n.setWander(false); n.setMood("idle");
      const shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "blue" }] };
      n.setDecor([{ id: "g", surface: "floor", u: 0.3, size: "small", shape }]);
      n.act("draw"); n.step(120 * 6);
      const si0 = c.act.si, h0 = c.act.r.h, S0 = n.S;
      size(724, 340); n.step(2); size(280, 200); n.step(2); size(724, 340); // 빠르게 돌림
      await wait(300); n.step(30); n.draw();
      const A = c.act, S = n.S, easelGap = Math.abs(A.r.cx - c.x), tipOff = A.tip ? Math.hypot(A.tip[0] - A.r.cx, A.tip[1] - A.r.cy) : 0;
      const out = {
        act: n.activity, kept: A.si >= si0, easelScale: +(A.r.h / h0).toFixed(2), sRatio: +(S / S0).toFixed(2),
        easelNear: easelGap < 80 * S, tipNear: tipOff < A.r.w * 1.2, catIn: c.x >= 0 && c.x <= n.W,
      };
      // 고양이가 바닥 선물을 덮지 않는다
      const gx = 16 * S + 0.3 * (n.W - 32 * S);
      out.offGift = Math.abs(c.x - gx) > 45 * S;
      // 털실: 새 무대에서 처음부터 — 공이 새 배율
      n.act("yarn"); n.step(60); const r0 = c.act.ball.r;
      size(280, 200); await wait(300); n.step(10);
      out.yarnBall = +(c.act.ball.r / r0).toFixed(2); out.sBack = +(n.S / S).toFixed(2);
      n.act(null);
      return out;
    });
    check("무대가 바뀌면 다시 편다: 이젤·붓은 새 자리·배율로 그림은 이어서, 털실은 새 배율로, 고양이는 선물을 덮지 않음", JSON.stringify(r),
      r.act === "draw" && r.kept && Math.abs(r.easelScale - r.sRatio) < 0.05 && r.easelNear && r.tipNear && r.offGift && Math.abs(r.yarnBall - r.sBack) < 0.05);
    await p.close();
  }

  // 9-f) 파일 물려주기(docs/neko-screen-mode.md §7, 화면 모드): 끄는 동안 하던 놀이를 멈추고 자던 고양이도 깨서 입이 커서 밑에 오게
  //      걸어온다. 입 원에 들어오면 '와앙' 한 번(나갔다 오면 또), 쓰다듬기는 안 켜진다, 그사이 온 활동은 끝난 뒤에. 문 아이콘 3장 겹침
  {
    const p = await open(`?world=1&fixed=0.8`, { width: 1400, height: 800 });
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, S = n.S;
      n.pause(); n.setWander(false); n.setMood("idle");
      // 놀이 중에 파일이 온다
      n.act("yarn"); n.step(120);
      const target = [c.x + 400 * S, n.floorY - 60 * S];
      n.fileDrag(target);
      const actAfter = n.activity;
      n.act("box"); // 감독이 그사이 보낸 활동은 끝난 뒤에
      for (let i = 0; i < 120 * 8; i++) n.step(1);
      const m = n.mouth, near = Math.abs(m.x - target[0]) < m.r;
      n.fileDrag([m.x, m.y]); n.step(20);
      const pet = n.react("pet");
      n.fileDrag(null); n.step(10);
      const afterAct = n.activity;
      // 자던 고양이도 깨서 온다
      n.act(null); n.setMood("sleepy"); n.setPose("lie"); n.step(120 * 3);
      const lay = c.mode;
      n.fileDrag([c.x - 300 * S, n.floorY - 60 * S]); n.step(120 * 2);
      const woke = c.mode !== "lie";
      n.fileDrag(null);
      // 문 아이콘 3장(파일·폴더)
      const icon = (col) => { const cv = new OffscreenCanvas(64, 64), g = cv.getContext("2d"); g.fillStyle = col; g.fillRect(12, 6, 40, 52); return cv.transferToImageBitmap(); };
      n.setPose("stand"); n.setMood("idle"); n.step(120);
      n.carry([{ id: "a", kind: "image", image: icon("#7aa7e0") }, { id: "b", kind: "image", image: icon("#e8c15a") }, { id: "c", kind: "image", image: icon("#d36a6a") }]);
      n.step(30); n.draw();
      return { actAfter, near, pet, afterAct, lay, woke, carried: n.carried().length, mouthR: Math.round(m.r), head: Math.round(n.head.r) };
    });
    check("파일 물려주기: 끌면 하던 걸 멈추고(자던 것도 깨서) 입이 커서 밑으로, 쓰다듬기 꺼짐, 그사이 활동은 끝난 뒤에, 아이콘 3장 물기", JSON.stringify(r),
      r.actAfter === null && r.near && r.pet === false && r.afterAct === "box" && r.lay === "lie" && r.woke && r.carried === 3 && r.mouthR > 0 && r.head > 0);
    await p.close();
  }

  // 9-g) 액자만 벽에 건다(0.1.24, 사용자): 액자 아닌 물건을 벽 쪽에 끌어 놓으면 고양이를 던졌을 때처럼 떨어져 튕기고 바닥에
  //      놓인다(decorMove 는 내려앉은 뒤 바닥 자리로 한 번). 액자는 벽에 그대로 걸린다
  {
    const p = await open(`?w=680&h=300&scale=height&transparent=1`, { width: 1000, height: 600 });
    const r = await p.evaluate(async () => {
      const n = window.__neko, cv = document.getElementById("stage"), shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
      n.pause(); n.setWander(false); n.cat.x = n.W * 0.8; n.step(30);
      const moves = []; n.on("decorMove", (e) => moves.push(e));
      const drop = async (frame) => {
        moves.length = 0;
        n.setDecor([{ id: "g", surface: "floor", u: 0.2, size: "small", shape, ...(frame ? { frame: true } : {}) }]); n.step(60); n.draw();
        const rect = cv.getBoundingClientRect();
        let gx = 0, gy = 0;
        for (let x = 0; x < n.W && !gx; x += 2) for (let y = n.floorY - 4; y > 0; y -= 2) if (n.hitDecor(x, y) === "g") { gx = x; gy = y; break; }
        const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, pointerId: 3, button: 0, pointerType: "mouse", bubbles: true }));
        ev("pointerdown", gx, gy); n.step(2);
        for (let k = 1; k <= 6; k++) { ev("pointermove", gx + 10 * k, gy - 25 * k); await new Promise((ok) => setTimeout(ok, 16)); n.step(2); }
        ev("pointerup", gx + 60, gy - 150);
        const right = moves.length;
        let landed = -1;
        for (let i = 0; i < 120 * 3; i++) { n.step(1); if (moves.length && landed < 0) landed = i; }
        return { right, moves: moves.map((m) => m.surface), landedSec: +(landed / 120).toFixed(2) };
      };
      return { plain: await drop(false), frame: await drop(true) };
    });
    check("액자만 벽에: 액자 아닌 물건은 떨어져 바닥에(내려앉은 뒤 바닥 자리 한 번), 액자는 벽에 걸린다", JSON.stringify(r),
      r.plain.right === 0 && r.plain.moves.join() === "floor" && r.plain.landedSec > 0.1 && r.frame.moves.join() === "wall");
    await p.close();
  }

  // 9-u0) 사용자와 놀기(0.1.28, 사용자): 바닥 물건을 흔들다 빠르게 놓으면 날아가 떨어져 굴러가다 서고(서면 decorMove 바닥), play(chase)를
  //       알린다 — 감독 대신 act("chase") 하면 달려가 앞발로 친다. 천천히 놓으면 그 자리. 낚싯대: 바구니를 누르면 실 끝 장난감이 손을
  //       따라 출렁이고 play(wand) 를 알린다 — act("wand") 면 웅크렸다 덮친다. 놓으면 바구니로 돌아간다
  {
    const p = await open(`?w=760&h=170&scale=height&transparent=1`, { width: 900, height: 300 });
    const r = await p.evaluate(async () => {
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage"), R = cv.getBoundingClientRect(), out = {};
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(0.68); n.setToys(true); n.step(30);
      const moves = [], plays = []; n.on("decorMove", (e) => moves.push(e)); n.on("play", (e) => { plays.push(e.kind); if (n.activity !== e.kind) n.act(e.kind); });
      const pe = (type, x, y, id) => cv.dispatchEvent(new PointerEvent(type, { clientX: R.left + x, clientY: R.top + y, pointerId: id, button: 0, pointerType: "mouse", bubbles: true }));
      const shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
      n.setDecor([{ id: "g", surface: "floor", u: 0.25, size: "small", shape }]); c.x = n.W * 0.8; n.step(120); n.draw();
      let b = null; for (let x = 0; x < n.W && !b; x += 2) for (let y = 0; y < n.floorY; y += 2) if (n.hitDecor(x, y) === "g") { b = [x, y]; break; }
      // 천천히 옮겨 놓기: 던지지 않는다
      pe("pointerdown", b[0], b[1], 2); n.step(2);
      for (let k = 1; k <= 5; k++) { pe("pointermove", b[0] + 2 * k, b[1], 2); await new Promise((ok) => setTimeout(ok, 60)); n.step(6); }
      pe("pointerup", b[0] + 10, b[1], 2); n.step(10);
      out.slow = { plays: plays.length, moves: moves.length };
      n.step(60); n.draw(); b = null; for (let x = 0; x < n.W && !b; x += 2) for (let y = 0; y < n.floorY; y += 2) if (n.hitDecor(x, y) === "g") { b = [x, y]; break; }
      // 휙 던지기
      moves.length = 0;
      pe("pointerdown", b[0], b[1], 3); n.step(2);
      for (let k = 1; k <= 5; k++) { pe("pointermove", b[0] + 14 * k, b[1] - 12 * k, 3); await new Promise((ok) => setTimeout(ok, 16)); n.step(2); }
      pe("pointerup", b[0] + 70, b[1] - 60, 3);
      let kicks = 0;
      for (let i = 0; i < 120 * 14; i++) { n.step(1); const A = c.act; if (A && A.key === "chase") kicks = Math.max(kicks, A.kicks || 0); }
      out.throw = { plays: plays.slice(), moves: moves.map((m) => m.surface), kicks, ended: n.activity === null };
      // 낚싯대
      plays.length = 0; c.x = n.W * 0.3; n.step(60);
      const [bx, by] = n.basket; pe("pointerdown", bx, by - 30, 4); n.step(2);
      let jumps = 0, pm = c.mode, swing = 0;
      for (let i = 0; i < 120 * 10; i++) {
        const t = i / 120, px = n.W * 0.5 + Math.sin(t * 0.8) * 60 * n.S, py = n.floorY - 100 * n.S + Math.sin(t * 2) * 25 * n.S;
        if (i % 2 === 0) pe("pointermove", px, py, 4);
        n.step(1); if (c.mode === "crouch" && pm !== "crouch") jumps++; pm = c.mode;
        const w = n.wandToy; if (w) swing = Math.max(swing, Math.abs(w.x - px));
      }
      const held = !!n.wandToy;
      pe("pointerup", n.W * 0.5, n.floorY - 90 * n.S, 4); n.step(90);
      out.wand = { plays: plays.length, act: n.activity, jumps, swing: Math.round(swing), held, back: n.wandToy === null };
      return out;
    });
    check("같이 놀기: 천천히 놓으면 그 자리, 휙 던지면 날아가 굴러 바닥에 서고(decorMove) 네코가 쫓아가 친다, 낚싯대는 손을 따라 출렁이고 네코가 덮치며 놓으면 바구니로", JSON.stringify(r),
      r.slow.plays === 0 && r.slow.moves === 1 && r.throw.plays[0] === "chase" && r.throw.moves.length >= 1 && r.throw.moves.every((m) => m === "floor") && r.throw.kicks >= 1 && r.throw.ended &&
        r.wand.plays >= 3 && r.wand.act === "wand" && r.wand.jumps >= 2 && r.wand.swing > 5 && r.wand.held && r.wand.back);
    await p.close();
  }

  // 9-u1) 벽 선물은 가구 뒤(0.1.27, 사용자: 가구 위에 액자가 걸리지 않게): 벽 층 캔버스(setWallCanvas)를 주면 벽에 건 액자는 거기에만
  //       그리고(고양이 캔버스엔 없음, 호스트가 정지 가구 층 밑에 둔다), 바닥 선물은 고양이 캔버스에. 끄는 동안은 고양이 캔버스(맨 위)로
  //       올라오고 벽 층에서 빠진다. 누르기·우클릭 정리는 그대로
  {
    const p = await open(`?w=760&h=170&scale=height&transparent=1`, { width: 900, height: 300 });
    const r = await p.evaluate(async () => {
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage"), R = cv.getBoundingClientRect(), k = cv.width / n.W;
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(0.68); c.x = n.W * 0.9; n.step(30);
      const wall = document.createElement("canvas"); n.setWallCanvas(wall);
      const shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
      n.setDecor([{ id: "f", surface: "wall", u: 0.3, v: 0.4, size: "large", shape, frame: true }, { id: "g", surface: "floor", u: 0.6, size: "small", shape }]);
      n.step(90); n.draw();
      const px = (g, x, y) => g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data[3];
      const mid = (id) => { let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; for (let x = 0; x < n.W; x += 2) for (let y = 0; y < n.floorY; y += 2) if (n.hitDecor(x, y) === id) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return [(x0 + x1) / 2, (y0 + y1) / 2]; };
      const fm = mid("f"), gm = mid("g"), wg = wall.getContext("2d"), mg = cv.getContext("2d");
      const still = { wall: px(wg, ...fm), main: px(mg, ...fm), floorMain: px(mg, ...gm), floorWall: px(wg, ...gm) };
      const menus = []; n.on("decorMenu", (e) => menus.push(e.id));
      cv.dispatchEvent(new MouseEvent("contextmenu", { clientX: R.left + fm[0], clientY: R.top + fm[1], bubbles: true, cancelable: true }));
      const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { clientX: R.left + x, clientY: R.top + y, pointerId: 7, button: 0, pointerType: "mouse", bubbles: true }));
      ev("pointerdown", fm[0], fm[1]); n.step(2);
      for (let i = 1; i <= 4; i++) { ev("pointermove", fm[0] + 8 * i, fm[1]); await new Promise((ok) => setTimeout(ok, 16)); n.step(2); }
      n.draw();
      const drag = { main: px(mg, fm[0] + 32, fm[1]), wall: px(wg, fm[0] + 32, fm[1]) };
      ev("pointerup", fm[0] + 32, fm[1]); n.step(30);
      return { still, menus, drag };
    });
    check("벽 선물은 가구 뒤: 벽 층에만 그림(고양이 캔버스엔 없음), 바닥 선물은 고양이 캔버스, 우클릭 정리 그대로, 끄는 동안은 고양이 캔버스(맨 위)", JSON.stringify(r),
      r.still.wall > 200 && r.still.main === 0 && r.still.floorMain > 200 && r.still.floorWall === 0 && r.menus.includes("f") && r.drag.main > 200 && r.drag.wall === 0);
    await p.close();
  }

  // 9-u2) 가구(docs/neko-furniture.md): 조명 톡(켜짐 알림·그동안 엔진이 그림), 캣타워 꼭대기까지, 캣휠 제자리 달리기(바퀴가 돈다, 쉬는 동안은 바퀴 안에서 헥헥),
  //       소파 위에 앉기, 졸리면 소파로, 상자 가구로 걸어가 쏙, 우클릭 '치우기' 자리, 올라 있던 가구를 치우면 떨어진다
  {
    const p = await open(`?w=1100&h=240&scale=height&transparent=1`, { width: 1300, height: 600 });
    const r = await p.evaluate(() => {
      const n = window.__neko, c = n.cat, out = {}, ev = [];
      n.pause(); n.setWander(false); n.setMood("idle");
      for (const k of ["lamp", "furnitureHeld", "furnitureMenu"]) n.on(k, (e) => ev.push([k, e]));
      n.setFurniture([{ id: "L", kind: "lamp", at: "dock", slot: 0 }, { id: "T", kind: "cattower", at: "dock", slot: 1 }, { id: "Wh", kind: "wheel", at: "dock", slot: 2 }, { id: "So", kind: "sofa", at: "dock", slot: 3 }]);
      const run = (key, sec, done) => { c.x = n.W * 0.5; n.act(key); for (let i = 0; i < 120 * sec; i++) { n.step(1); if (done && done()) break; } };
      run("lamp", 12, () => !n.activity);
      out.lamp = { on: n.furniture.find((f) => f.id === "L").on, events: ev.filter(([k]) => k === "lamp").length, held: ev.some(([k, e]) => k === "furnitureHeld" && e.includes("L")) };
      n.act(null); n.step(60);
      run("cattower", 25, () => c.perch && c.perch.fid === "T" && c.perch.y < n.floorY + 1 && c.perch.y === Math.min(...[c.perch.y]) && c.perch.id.endsWith(":1"));
      out.tower = { perch: c.perch ? c.perch.id : null };
      n.act(null); n.step(240);
      for (let i = 0; i < 120 * 6 && c.perch; i++) n.step(1); // 내려오기를 기다린다(감독이 다른 걸 시키면 내려온다)
      run("wheel", 10, () => c.treadmill && Math.abs(c.x - n.W * 0.625) < 30);
      const x0 = c.x, s0 = n.debug ? 0 : 0; n.step(120);
      out.wheel = { running: !!c.treadmill, stayed: Math.abs(c.x - x0) < 3, held: ev.some(([k, e]) => k === "furnitureHeld" && e.includes("Wh")), mode: c.mode };
      for (let i = 0; i < 120 * 12 && !(c.mode === "act" && c.actP && c.actP.pant > 0.3); i++) n.step(1); // 숨 고르기: 바퀴 안에서 헥헥
      out.wheelRest = { mode: c.mode, perch: c.perch ? c.perch.fid : null, pant: !!(c.actP && c.actP.pant > 0.3) };
      n.act(null); n.step(60);
      out.wheelStopped = { mode: c.mode, treadmill: !!c.treadmill };
      run("sofa", 15, () => c.perch && c.perch.fid === "So" && c.mode === "act");
      out.sofa = { perch: c.perch ? c.perch.fid : null, mode: c.mode };
      n.act(null); n.step(60);
      // 올라 있던 가구를 치우면 떨어진다
      n.setFurniture([{ id: "L", kind: "lamp", at: "dock", slot: 0 }, { id: "Wh", kind: "wheel", at: "dock", slot: 2 }, { id: "B", kind: "box", at: "dock", slot: 1 }]);
      for (let i = 0; i < 120 * 2; i++) n.step(1);
      out.fell = { perch: c.perch, onFloor: Math.abs(n.floorY - (240 - 6)) < 2 };
      // 상자 가구로 걸어가 쏙
      run("box", 12, () => c.mode === "act");
      out.box = { mode: c.mode, x: Math.round(c.x), boxX: Math.round(n.W * 0.375) };
      n.act(null); n.step(60);
      // 졸리면 소파로(다시 소파를 놓고)
      n.setFurniture([{ id: "So", kind: "sofa", at: "dock", slot: 3 }]);
      c.x = n.W * 0.3; n.setMood("sleepy"); n.setPose("loaf");
      for (let i = 0; i < 120 * 15 && !(c.perch && c.perch.fid === "So" && c.mode === "loaf"); i++) n.step(1);
      out.sleep = { perch: c.perch ? c.perch.fid : null, mode: c.mode };
      // 우클릭 '치우기' 자리
      n.setMood("idle"); n.setPose("stand"); n.setFurniture([{ id: "L", kind: "lamp", at: "dock", slot: 0 }]); c.x = n.W * 0.8; n.step(120);
      const cv = document.getElementById("stage"), R = cv.getBoundingClientRect();
      cv.dispatchEvent(new MouseEvent("contextmenu", { clientX: R.left + n.W * 0.125, clientY: R.top + n.floorY - 40 * n.S, bubbles: true, cancelable: true }));
      out.menu = ev.some(([k, e]) => k === "furnitureMenu" && e.id === "L");
      return out;
    });
    check("가구 놀이: 조명 톡·캣타워 꼭대기·캣휠 제자리·숨 고르기는 바퀴 안에서 헥헥·소파 위·치우면 떨어짐·상자 가구·졸리면 소파·우클릭 치우기", JSON.stringify(r),
      r.lamp.on && r.lamp.events === 1 && r.lamp.held && r.tower.perch === "f:T:1" && r.wheel.running && r.wheel.stayed && r.wheel.held && r.wheelRest.perch === "Wh" && r.wheelRest.pant &&
        !r.wheelStopped.treadmill && r.sofa.perch === "So" && r.sofa.mode === "act" && !r.fell.perch && r.box.mode === "act" && Math.abs(r.box.x - r.box.boxX) < 12 &&
        r.sleep.perch === "So" && r.menu);
    await p.close();
  }

  // 9-u2b) 캣휠(0.1.26, 사용자: 안에서 달리지 않고 들어갔다 나왔다만 한다·꼬리가 테 밖으로 나오면 깜빡인다). 맥 방 폭 280 의 끝 칸 캣휠:
  //        첫 점프에 레일 위로(예전엔 착지 자리가 벽 여백 안쪽이라 벽에 튕겨 바닥으로 떨어지고 다시 뛰기만 했다), 안에 있는 동안 앞 겹 inV 가
  //        1 에 머문다(1 ↔ 0.97 이면 자르기 원이 프레임마다 커졌다 줄어 깜빡였다), 숨 고르기 동안 맡은 바퀴를 엔진이 그린다(안 그려 사라졌다),
  //        끝나면 바퀴 밖으로 나온다
  {
    const p = await open(`?w=280&h=326&scale=height&transparent=1`, { width: 400, height: 400 });
    const r = await p.evaluate(async () => {
      const FA = await import("/src/neko/engine/furniture-art.js");
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage"), g = cv.getContext("2d"), k = cv.width / n.W, out = {};
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(1.12); n.step(30);
      let held = []; n.on("furnitureHeld", (e) => (held = e));
      n.setFurniture([{ id: "Wh", kind: "wheel", at: "sidebar", slot: 0 }]);
      c.x = n.W * 0.8; n.step(60); const base = n.floorY; n.act("wheel");
      let hops = 0, pm = c.mode;
      for (let i = 0; i < 120 * 12 && !c.treadmill; i++) { n.step(1); if (c.mode === "air" && pm !== "air") hops++; pm = c.mode; }
      out.enter = { hops, treadmill: !!c.treadmill };
      n.step(60);
      const inV = []; for (let i = 0; i < 6; i++) { n.step(1); inV.push(n.furniture[0].inV); }
      out.inV = inV.every((v) => v === 1);
      for (let i = 0; i < 120 * 12 && c.mode !== "act"; i++) n.step(1); // 숨 고르기
      n.step(60); n.draw();
      // 바퀴 아래 띠(바닥 위 2~12%, 고양이는 레일 위라 없다)에 엔진이 그린 화소
      const b = FA.furnitureBox("wheel", n.S, n.W / 2), x0 = n.W / 4 - b.w * 0.45, y0 = base - b.h * 0.12;
      const d = g.getImageData(Math.round(x0 * k), Math.round(y0 * k), Math.round(b.w * 0.9 * k), Math.round(b.h * 0.1 * k)).data;
      let px = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) px++;
      out.rest = { mode: c.mode, held: held.includes("Wh"), px };
      n.act(null);
      for (let i = 0; i < 120 * 4 && c.perch; i++) n.step(1);
      out.left = !c.perch;
      return out;
    });
    check("캣휠: 좁은 방 끝 칸에도 첫 점프에 레일 위로, 안에선 앞 겹이 1 에 머묾, 숨 고르기 동안 맡은 바퀴를 엔진이 그림, 끝나면 밖으로", JSON.stringify(r),
      r.enter.treadmill && r.enter.hops === 1 && r.inV && r.rest.mode === "act" && r.rest.held && r.rest.px > 50 && r.left);
    await p.close();
  }

  // 9-u2c) 캣휠 안 폴짝(0.1.26, 사용자: 안에서 점프해 테를 뚫고 위로 나갔다): 달리다 뛰면(냥) 귀 끝이 테 안쪽 원 위로 안 나가고
  //        제자리(레일 위·달리기 그대로)에 내려앉는다. 바퀴 앞 바닥에서 뛰면 레일에 안 내린다(테를 뚫고 안 들어간다)
  {
    const p = await open(`?w=760&h=170&scale=height&transparent=1`, { width: 900, height: 300 });
    const r = await p.evaluate(async () => {
      const FA = await import("/src/neko/engine/furniture-art.js");
      const n = window.__neko, c = n.cat, out = {};
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(0.68); n.step(30);
      n.setFurniture([{ id: "Wh", kind: "wheel", at: "dock", slot: 2 }]);
      c.x = n.W * 0.2; n.step(60);
      const wc = FA.wheelCircle(n.S, n.W / 4), fx = n.W * 0.625, top = n.floorY + wc.dy - wc.rIn;
      n.act("wheel");
      for (let i = 0; i < 120 * 15 && !(c.treadmill && c.modeT > 0.5); i++) n.step(1);
      out.hops = [0, 1].map(() => {
        const x0 = c.x; let air = 0, over = -1e9; n.react("nyang");
        for (let i = 0; i < 120 * 1.2; i++) { n.step(1); if (c.mode === "air") air++; over = Math.max(over, top - (c.y - (84 + 18 * c.soft) * n.S)); }
        return { air: +(air / 120).toFixed(2), over: +over.toFixed(1), dx: +(c.x - x0).toFixed(1), perch: c.perch && c.perch.fid, tread: !!c.treadmill };
      });
      n.act(null); for (let i = 0; i < 120 * 4 && c.perch; i++) n.step(1); n.step(120);
      c.x = fx; n.step(60); n.react("nyang"); for (let i = 0; i < 120 * 2; i++) n.step(1);
      out.floor = c.perch ? c.perch.fid : null;
      return out;
    });
    check("캣휠 안 폴짝: 귀 끝이 테 안쪽 원 안, 제자리 레일 위에 내려앉아 계속 달림, 바퀴 앞 바닥 점프는 레일에 안 내림", JSON.stringify(r),
      r.hops.every((h) => h.air > 0.1 && h.over <= 1 && h.dx === 0 && h.perch === "Wh" && h.tread) && r.floor === null);
    await p.close();
  }

  // 9-u2d) 상자 가구 안(0.1.28, 사용자: 상자에 들어가면 몸통이 밖으로 빠져나옴): 맥 방 폭 280(S 1.12, 상자가 칸에 맞춰 작다)·통통·긴 털도
  //        들어가 있는 동안 테두리 아래로는 상자 앞벽 폭 밖에 고양이가 한 점도 안 보인다(머리는 테두리 위로 보인다)
  {
    const p = await open(`?w=280&h=326&scale=height&transparent=1`, { width: 400, height: 400 });
    const r = await p.evaluate(async () => {
      const FA = await import("/src/neko/engine/furniture-art.js");
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage"), g = cv.getContext("2d"), k = cv.width / n.W;
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(1.12); n.setAppearance({ build: "chubby", fur: "long" }); n.step(60);
      n.setFurniture([{ id: "B", kind: "box", at: "sidebar", slot: 1 }]);
      c.x = n.W * 0.3; n.step(60); const base = n.floorY, fx = n.W * 0.75, o = FA.boxOpening(n.S, n.W / 2);
      n.act("box");
      let frames = 0, out = 0, head = 0;
      for (let i = 0; i < 120 * 14; i++) {
        n.step(1);
        const A = c.act; if (!(c.mode === "act" && A && A.t - A.ta > 1)) continue;
        if (i % 12) continue;
        n.draw(); frames++;
        const y0 = Math.round((base + o.rim + 3 * n.S) * k), y1 = Math.round((base - 9 * n.S) * k), d = g.getImageData(0, y0, cv.width, y1 - y0).data;
        for (let y = 0; y < y1 - y0; y++) for (let x = 0; x < cv.width; x++) {
          const X = x / k; if (X > fx + o.x0 - 2 && X < fx + o.x1 + 2) continue;
          if (d[(y * cv.width + x) * 4 + 3] > 40) out++;
        }
        head = Math.max(head, base + o.rim - c.head.y);
      }
      return { frames, out, headAbove: Math.round(head) };
    });
    check("상자 가구 안: 테두리 아래 상자 앞벽 폭 밖엔 고양이가 안 보인다(좁은 방·통통·긴 털), 머리는 테두리 위로", JSON.stringify(r), r.frames > 20 && r.out === 0 && r.headAbove > 0);
    await p.close();
  }

  // 9-u2e) 탁자 위 물건(0.1.28, 사용자: 탁자 위에 물건을 둔다): 자리 furniture(fid·i·fu·u)면 상판 위에 그리고, 바닥 물건을 끌어 상판 근처에
  //        놓으면 그 위(decorMove furniture), 탁자를 치우고 호스트가 바닥 u 로 다시 넣으면 상판 자리에서 떨어져 바닥에 선다(decorMove floor)
  {
    const p = await open(`?w=760&h=170&scale=height&transparent=1`, { width: 900, height: 300 });
    const r = await p.evaluate(async () => {
      const FA = await import("/src/neko/engine/furniture-art.js");
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage"), R = cv.getBoundingClientRect(), out = {};
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(0.68); n.step(30);
      const slotW = n.W / 4, tx = 1.5 * slotW, top = FA.furnitureSurfaces("table", n.S, slotW)[0], topY = n.floorY - top.y;
      n.setFurniture([{ id: "T", kind: "table", at: "dock", slot: 1 }]);
      const moves = []; n.on("decorMove", (e) => moves.push(e));
      const shape = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
      n.setDecor([{ id: "a", surface: "furniture", fid: "T", i: 0, fu: 0.3, u: 0.3, size: "small", shape }, { id: "b", surface: "floor", u: 0.9, size: "small", shape }]);
      c.x = n.W * 0.1; n.step(60); n.draw();
      const boxOf = (id) => { let x0 = 1e9, x1 = -1, y1 = -1; for (let x = 0; x < n.W; x++) for (let y = 0; y < n.H; y++) if (n.hitDecor(x, y) === id) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return { cx: (x0 + x1) / 2, bottom: y1 }; };
      const a = boxOf("a"); out.onTop = Math.abs(a.bottom - topY) < 5 && a.cx > tx + top.x0 && a.cx < tx + top.x1;
      const b = boxOf("b"), pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { clientX: R.left + x, clientY: R.top + y, pointerId: 9, button: 0, pointerType: "mouse", bubbles: true }));
      pe("pointerdown", b.cx, b.bottom - 4); n.step(2);
      for (let k = 1; k <= 12; k++) { pe("pointermove", b.cx + (tx + 10 * n.S - b.cx) * k / 12, b.bottom - 4 + (topY - 6 - b.bottom) * k / 12); await new Promise((ok) => setTimeout(ok, 30)); n.step(4); }
      await new Promise((ok) => setTimeout(ok, 150));
      pe("pointerup", tx + 10 * n.S, topY - 6); n.step(4);
      out.drop = moves.length ? moves[moves.length - 1].surface : null;
      moves.length = 0; n.setFurniture([]);
      n.setDecor([{ id: "a", surface: "floor", u: 0.3, size: "small", shape }]);
      n.step(4); const mid = boxOf("a").bottom;
      for (let i = 0; i < 120 * 2; i++) n.step(1);
      out.fall = { midAir: mid < n.floorY - 8, moves: moves.map((m) => m.surface) };
      return out;
    });
    check("탁자 위 물건: 상판 위에 그린다, 끌어 상판에 놓으면 그 위, 탁자를 치우면 그 자리에서 떨어져 바닥", JSON.stringify(r),
      r.onTop && r.drop === "furniture" && r.fall.midAir && r.fall.moves.join() === "floor");
    await p.close();
  }

  // 9-u2f) 끝 칸 가구에서 내려오기(0.1.28, 사용자: 폰 거실 왼쪽 끝 캣타워에서 내려오려고 왼쪽으로 뛰면 벽에 막혀 계속 부딪힘): 벽 쪽 끝에서
  //        내려오려 하면 열린 쪽(무대 안쪽)으로 뛰고, 아래 발판(캣타워 1층)에 내렸으면 바닥까지 마저 내려온다. 맥 방·맥 거실·폰 세로 거실·
  //        폰 가로의 왼쪽·오른쪽 끝 칸, 캣타워 2층·소파. 캣타워 놀이를 그대로 돌려도 공중에서 벽에 튕기지 않는다
  {
    const out = [];
    for (const [name, w, h, S, at, slots] of [["맥 방", 280, 200, 0.81, "sidebar", [0, 1]], ["맥 거실", 760, 170, 0.68, "dock", [0, 3]],
      ["폰 세로 거실", 375, 120, 0.35, "dock", [0, 3]], ["폰 가로", 812, 375, 0.98, "dock", [0, 3]]]) {
      const p = await open(`?w=${w}&h=${h}&scale=height&transparent=1`, { width: w + 100, height: h + 100 });
      for (const kind of ["cattower", "sofa"]) for (const slot of slots) {
        const r = await p.evaluate(({ S, at, slot, kind }) => {
          const n = window.__neko, c = n.cat;
          // 벽에 부딪힘 = 공중에서 가로 속도가 뒤집힘(walls 가 벽 여백에서 튕겨 낸다). 끝 칸 가구 자체가 벽 여백 안에 있을 수 있어 자리로는 못 본다
          let sv = 0;
          const bounced = () => { if (c.mode !== "air") { sv = 0; return false; } const s = Math.sign(Math.round(c.vx)); const hit = sv && s && s !== sv; if (s) sv = s; return hit; };
          n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(S); n.act(null); n.step(30);
          n.setFurniture([{ id: "F", kind, at, slot }]);
          c.x = n.W / 2; n.step(60); n.act(kind);
          const want = kind === "cattower" ? ":1" : ":0";
          let up = false;
          for (let i = 0; i < 120 * 25 && !up; i++) { n.step(1); up = !!(c.perch && c.perch.id.endsWith(want)); }
          if (!up) return { up };
          for (let i = 0; i < 120 * 3 && (c.mode === "air" || c.mode === "land"); i++) n.step(1); // 올라앉아 자리 잡을 때까지
          // 벽 쪽 끝 가까이에 세우고 바닥 놀이를 시킨다(가까운 쪽 = 벽 쪽으로 내려가려 한다)
          const left = slot === 0, span = c.perch.x1 - c.perch.x0;
          c.x = left ? c.perch.x0 + 0.3 * span : c.perch.x1 - 0.3 * span; n.step(2);
          n.act("yarn");
          let t = 0, wall = 0;
          for (; t < 120 * 8 && (c.perch || c.mode === "air" || c.mode === "fall"); t++) { // 바닥에 닿을 때까지만(그 뒤 털실 놀이의 뜀은 안 센다)
            n.step(1); if (bounced()) wall++;
          }
          const down = !c.perch && t < 120 * 8;
          // 캣타워 놀이를 그대로 40초: 공중에서 벽 여백에 닿지 않는다
          let towerWall = 0, floors = 0, pp = !!c.perch;
          if (kind === "cattower") {
            n.act("cattower");
            for (let i = 0; i < 120 * 40; i++) {
              n.step(1);
              if (bounced()) towerWall++;
              if (pp && !c.perch) floors++; pp = !!c.perch;
            }
          }
          return { up, down, sec: +(t / 120).toFixed(1), wall, towerWall, floors };
        }, { S, at, slot, kind });
        out.push({ name, kind, slot, ...r });
      }
      await p.close();
    }
    const bad = out.filter((r) => !r.up || !r.down || r.wall || r.towerWall);
    check("끝 칸 가구에서 내려오기: 벽 쪽이 막히면 열린 쪽으로, 아래 발판에서 바닥까지 — 공중에서 벽에 안 튕긴다", JSON.stringify(bad.length ? bad : out.map((r) => `${r.name}/${r.kind}/${r.slot}:${r.sec}s`)), bad.length === 0);
  }

  // 9-u2g) 탁자 놀이(0.1.28, 사용자: 탁자 위 물건을 가끔 툭 밀어 떨어뜨린다): 밀 판이면 탁자 옆 바닥에 서서 올려다보다(stare) 앞발로
  //        자기 쪽 끝으로 끌어 떨어뜨리고(물건 decorMove floor), 그다음 윗면에 올라가 쉰다. 맥 방 280 의 벽 끝 칸 탁자도 반대쪽 끝에서
  for (const [q, at, slot, sc] of [["?w=760&h=170&scale=height&transparent=1", "dock", 1, 0.68], ["?w=280&h=326&scale=height&transparent=1", "sidebar", 0, 1.12]]) {
    const p = await open(q, { width: 900, height: 400 });
    const r = await p.evaluate(({ at, slot, sc }) => {
      const n = window.__neko, c = n.cat;
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(sc); n.step(30);
      n.setFurniture([{ id: "T", kind: "table", at, slot }]);
      const moves = []; n.on("decorMove", (e) => moves.push(e.id + ":" + e.surface));
      n.setDecor([{ id: "a", surface: "furniture", fid: "T", i: 0, fu: 0.35, u: 0.3, size: "small", shape: { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] } }]);
      c.x = n.W * (slot ? 0.1 : 0.9); n.step(60);
      const rnd = Math.random; Math.random = () => 0.1; n.act("table"); Math.random = rnd; // 밀 판(45%)으로
      const seen = [];
      for (let i = 0; i < 120 * 20; i++) { n.step(1); const st = c.act ? c.act.stage : "-"; if (seen[seen.length - 1] !== st) seen.push(st); }
      return { seen: seen.join(">"), moves, perch: n.perch };
    }, { at, slot, sc });
    check(`탁자 놀이(${at}): 옆 바닥에서 올려다보다 끌어 떨어뜨리고 올라가 쉰다`, JSON.stringify(r),
      /stare>push>watch>go>rest/.test(r.seen) && r.moves.join() === "a:floor" && r.perch === "f:T:0");
    await p.close();
  }

  // 9-u2h) 액자 반응(0.1.28, 사용자: 꼬리 살랑·앞발 들기·점프해서 떨구기): 벽 액자 놀이로 tail·reach·knock 를 고르고, 떨구기는 뛰어올라
  //        쳐서 액자가 떨어져 바닥에 눕는다(decorMove floor, 칸 가로세로 바뀜). 누운 액자를 그냥 누르고 떼면 그대로, 끌어 놓으면 벽(맨 아래)에 건다.
  //        너무 높은 액자는 떨구기를 고르지 않는다(맥 방 280×326 — 거실 170 은 낮아 맨 위 액자도 뛰면 닿는다)
  {
    const p = await open(`?w=280&h=326&scale=height&transparent=1`, { width: 500, height: 450 });
    const r = await p.evaluate(async () => {
      const n = window.__neko, c = n.cat, cv = document.getElementById("stage"), R = cv.getBoundingClientRect(), out = {};
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(1.12); n.step(30);
      const moves = []; n.on("decorMove", (e) => moves.push(e.surface));
      const shape = { parts: [{ t: "rrect", x: 0, y: -10, w: 26, h: 20, rad: 2, rot: 0, c: "blue" }] };
      const pick = (v, rr) => { n.act(null); n.setDecor([{ id: "f", surface: "wall", u: 0.5, v, size: "medium", shape, frame: true }]); c.x = n.W * 0.2; n.step(60);
        const rnd = Math.random; Math.random = () => rr; n.act("giftplay"); Math.random = rnd; return c.act && c.act.play; };
      out.chose = { tail: pick(0.15, 0.3), reach: pick(0.15, 0.6), knock: pick(0.15, 0.05), high: pick(1, 0.05) };
      pick(0.15, 0.05); moves.length = 0;
      for (let i = 0; i < 120 * 10 && n.activity; i++) n.step(1);
      for (let i = 0; i < 240; i++) n.step(1);
      out.fell = moves.slice();
      n.act(null); c.x = n.W * 0.1; n.setDecor([{ id: "f", surface: "floor", u: 0.7, size: "medium", shape, frame: true }]); n.step(60); n.draw(); // 고양이는 비켜 둔다(누르기가 고양이에 먼저 걸리지 않게)
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1; for (let x = 0; x < n.W; x++) for (let y = 0; y < n.H; y++) if (n.hitDecor(x, y) === "f") { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      out.lies = (y1 - y0) > (x1 - x0); // 가로 26·세로 20 액자가 옆으로 누워 세로가 길다
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, pe = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { clientX: R.left + x, clientY: R.top + y, pointerId: 5, button: 0, pointerType: "mouse", bubbles: true }));
      moves.length = 0; pe("pointerdown", cx, cy); n.step(2); pe("pointerup", cx, cy); n.step(2);
      out.tap = moves.slice();
      moves.length = 0; pe("pointerdown", cx, cy); n.step(2);
      for (let k = 1; k <= 6; k++) { pe("pointermove", cx + 4 * k, cy); await new Promise((ok) => setTimeout(ok, 30)); n.step(4); }
      await new Promise((ok) => setTimeout(ok, 150)); pe("pointerup", cx + 24, cy); n.step(2);
      out.drag = moves.slice();
      return out;
    });
    check("액자 반응: 꼬리 살랑·앞발 들기·떨구기를 고르고(높으면 떨구기 없음), 떨구면 바닥에 눕는다, 누운 액자 누르기는 그대로·끌어 놓으면 벽에 건다", JSON.stringify(r),
      r.chose.tail === "tail" && r.chose.reach === "reach" && r.chose.knock === "knock" && r.chose.high !== "knock" && r.fell.join() === "floor" && r.lies && r.tap.join() === "floor" && r.drag.join() === "wall");
    await p.close();
  }

  // 9-u2i) 자유 가구(0.1.28, docs/neko-furniture-free.md): 쓰임새 넷짜리 모양(checkFurniture)을 그리고 furniture 값에 켜진 쓰임새를 싣는다.
  //        fperch 는 면 위에 올라가(푹신하면 꾹꾹이) 쉬고, fhide 는 입구 안에서 앞 겹이 가린다(inV), fscratch·fbat 는 그 앞에 서서 한 판씩
  {
    const p = await open(`?w=760&h=170&scale=height&transparent=1`, { width: 900, height: 300 });
    const r = await p.evaluate(async () => {
      const FU = await import("/src/neko/furnitureUses.ts");
      const n = window.__neko, c = n.cat, out = {};
      n.pause(); n.setWander(false); n.setMood("idle"); n.setScale(0.68); n.step(30);
      const raw = { v: 1, parts: [
        { t: "rrect", x: 0, y: -6.5, w: 20, h: 13, rad: 1, rot: 0, c: "brown" }, { t: "rrect", x: 0, y: -5, w: 12, h: 8, rad: 3, rot: 0, c: "brown.dark" },
        { t: "rrect", x: 0, y: -2.5, w: 16, h: 5, rad: 0.8, rot: 0, c: "brown.light" }, { t: "rrect", x: 0, y: -13.6, w: 22, h: 1.6, rad: 0.7, rot: 0, c: "red" },
        { t: "line", pts: [[10, -13], [14.5, -13], [14.5, -10]], w: 0.4, c: "brown.dark" }, { t: "circle", x: 14.5, y: -9.2, r: 1, c: "yellow" }] };
      const chk = FU.checkFurniture(raw, [{ u: "perch", y: -14.4, x0: -10, x1: 10, soft: true }, { u: "inside", x0: -6, x1: 6, rim: -5, front: [2] }, { u: "scratch", side: "left", x: -10, top: -12 }, { u: "bat", x: 14.5, y: -9.2 }]);
      n.setFurniture([{ id: "F", kind: "free", at: "dock", slot: 1, shape: chk.shape, uses: chk.uses }]);
      out.uses = n.furniture[0].uses.join();
      for (const key of ["fperch", "fhide", "fscratch", "fbat"]) {
        n.act(null); for (let i = 0; i < 120 * 3 && n.perch; i++) n.step(1); c.x = n.W * 0.1; n.step(60);
        n.act(key); const seen = new Set(); let inV = 0;
        for (let i = 0; i < 120 * 14; i++) { n.step(1); const A = c.act; if (A) seen.add(A.stage || A.ph); inV = Math.max(inV, n.furniture[0].inV); }
        out[key] = { seen: [...seen].join(), perch: n.perch, act: n.activity, inV: +inV.toFixed(2) };
      }
      return out;
    });
    check("자유 가구: 쓰임새 넷이 켜지고, 올라앉기(꾹꾹이)·숨기(앞 겹)·긁기·치기가 그 자리에서", JSON.stringify(r),
      r.uses === "perch,inside,scratch,bat" && r.fperch.perch === "f:F:0" && /knead/.test(r.fperch.seen) && r.fhide.act === "fhide" && r.fhide.inV === 1 &&
        /scratch/.test(r.fscratch.seen) && /bat/.test(r.fbat.seen));
    await p.close();
  }

  // 9-u3)물고 있는 채로 상자 뒤지기(사용자: Finder 를 켜면 상자를 뒤지는데 입에 문 게 상자 밖으로 튀어나와 보였다). 문 물건은 고양이와 같은 겹 —
  //       다 들어간 뒤(0.8초~)엔 상자 앞면 아래 절반에 문 물건(자홍 칸)이 한 점도 안 보인다. 뿅 상자·상자 가구 둘 다. 상자 위로 내민 땐 보인다
  for (const furn of [false, true]) {
    const p = await open(furn ? `?w=1100&h=240&scale=height&transparent=1` : "", { width: 1300, height: 1000 });
    const r = await p.evaluate((furn) => {
      const n = window.__neko, c = n.cat, cv = document.querySelector("canvas"), g = cv.getContext("2d"), k = cv.width / cv.getBoundingClientRect().width;
      n.pause(); n.setWander(false); n.setMood("idle");
      if (furn) n.setFurniture([{ id: "B", kind: "box", at: "dock", slot: 1 }]);
      const img = document.createElement("canvas"); img.width = img.height = 40; const ig = img.getContext("2d"); ig.fillStyle = "#ff00ff"; ig.fillRect(0, 0, 40, 40);
      n.carry({ id: "m", kind: "image", image: img }); n.step(60); n.act("box");
      const magenta = (x, y, w, h) => { const d = g.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data; let m = 0; for (let j = 0; j < d.length; j += 4) if (d[j] > 230 && d[j + 1] < 40 && d[j + 2] > 230) m++; return m; };
      let frames = 0, leak = 0, seen = 0;
      for (let i = 0; i < 120 * 14; i++) {
        n.step(1);
        if (i % 12 || !c.act || c.act.key !== "box" || c.mode !== "act" || c.act.t - c.act.ta < 0.8) continue;
        n.draw(); frames++;
        const b = c.act.box, x0 = Math.round((b.x - b.w / 2 + 4) * k), y0 = Math.round((n.floorY - b.h * 0.5) * k);
        leak = Math.max(leak, magenta(x0, y0, Math.round((b.w - 8) * k), Math.round((b.h * 0.5 - 2) * k)));
        if (magenta(0, 0, cv.width, cv.height)) seen++;
      }
      return { furn, frames, leak, seen, carrying: n.carrying };
    }, furn);
    check(`물고 있는 채로 상자 뒤지기(${furn ? "상자 가구" : "뿅 상자"}): 문 물건이 상자 앞면에 가려진다`, JSON.stringify(r), r.frames > 40 && r.leak === 0 && r.seen > 0 && r.carrying);
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

  // 12) 오래 뒤에 있다 오기(폰): iOS 가 캔버스 내용을 버려도 다시 보이면 고양이·산책 팻말이 다시 그려진다
  {
    const p = await open("?transparent=1");
    const r = await p.evaluate(async () => {
      const n = window.__neko, cv = document.getElementById("stage"), sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const opaque = () => { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) k++; return k; };
      const show = (hidden) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event("visibilitychange"));
      };
      n.draw();
      const before = opaque();
      show(true);
      for (const k of ["body", "head"]) { const c = n.cat.coatTex[k].canvas; c.width = c.width; } // 털 무늬 캔버스가 비었다
      show(false); await sleep(300);
      n.draw();
      const after = opaque();
      n.setAway(true); await sleep(2000);
      const sign = opaque();
      show(true); cv.width = cv.width; show(false); await sleep(300); // 다 그린 팻말이 지워졌다
      const signAfter = opaque();
      delete document.hidden;
      return { before, after, sign, signAfter };
    });
    check("뒤에 있다 오기: 비워진 털 무늬·팻말을 다시 그림", `고양이 ${r.before}→${r.after}px · 팻말 ${r.sign}→${r.signAfter}px`,
      r.after > r.before * 0.95 && r.sign > 0 && r.signAfter > r.sign * 0.95);
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
