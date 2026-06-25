// src/engine/reckless.worker.ts
//
// Bridge UCI ↔ Engine WASM (reckless).
//
// Desain:
//   • Semua command dari useStockfish.ts masuk sebagai string UCI standar
//     ("uci", "isready", "ucinewgame", "position fen ...", "go depth N",
//      "go movetime N", "setoption name MultiPV value N", "stop").
//   • Worker menjawab dengan string UCI standar pula:
//     "uciok", "readyok", "info depth N multipv N score cp N nodes N nps N time N pv ...",
//     "bestmove <move>".
//   • Engine.go_uci / go_movetime adalah BLOCKING (tidak ada await di sisi
//     WASM) tetapi memanggil callback on_info BERKALI-KALI selama search
//     berjalan — setiap PV/depth baru dikirim ke main thread via on_info.
//   • MultiPV dikontrol lewat parameter langsung ke go_uci/go_movetime.
//     "setoption name MultiPV value N" disimpan di lastKnownMultiPv dan
//     dipakai saat command "go" berikutnya.
//   • Format string yang on_info kirim diasumsikan UCI standar:
//     "info depth D multipv P score cp C nodes N nps S time T pv e2e4 ..."
//     Parser toleran (regex per-field). Kalau parsing gagal, baris di-skip
//     + console.warn supaya gampang debug.

// @ts-ignore
import init, { Engine } from "./pkg/reckless.js";

// ── State worker ────────────────────────────────────────────────────────────

let engine: Engine | null = null;
let isInitializing = false;
let lastKnownMultiPv = 2; // default cukup 2 agar brilliant/great/forced bisa terdeteksi

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// ── UCI info-line parser ─────────────────────────────────────────────────────

interface ParsedInfo {
  depth: number;
  multipv: number;
  cp: number | null;
  mate: number | null;
  nodes: number | null;
  nps: number | null;
  time: number | null;
  pv: string[];
}

/**
 * Parse satu baris UCI "info depth ... score cp ... pv ..."
 * Return null kalau baris tidak mengandung depth (bukan baris search).
 */
function parseInfoLine(line: string): ParsedInfo | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  if (!depthMatch) return null;

  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const nodesMatch = line.match(/\bnodes (\d+)/);
  const npsMatch = line.match(/\bnps (\d+)/);
  const timeMatch = line.match(/\btime (\d+)/);
  const pvMatch = line.match(/\bpv (.+)$/);

  return {
    depth: parseInt(depthMatch[1], 10),
    multipv: multipvMatch ? parseInt(multipvMatch[1], 10) : 1,
    cp: cpMatch ? parseInt(cpMatch[1], 10) : null,
    mate: mateMatch ? parseInt(mateMatch[1], 10) : null,
    nodes: nodesMatch ? parseInt(nodesMatch[1], 10) : null,
    nps: npsMatch ? parseInt(npsMatch[1], 10) : null,
    time: timeMatch ? parseInt(timeMatch[1], 10) : null,
    pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : [],
  };
}

/**
 * Terima raw string dari on_info, parse, rebuild sebagai baris UCI canonical,
 * lalu postMessage ke main thread.
 * Baris yang gagal parse (tidak ada "depth") di-skip dengan warning.
 */
function forwardInfoLine(raw: string): void {
  const p = parseInfoLine(raw);
  if (!p) {
    // Bisa jadi baris "info string ..." atau format tidak dikenal — skip diam-diam
    // kecuali ada kata kunci yang harusnya punya depth tapi tidak.
    if (raw.includes("score") && !raw.includes("depth")) {
      console.warn(
        "[reckless.worker] on_info: baris score tanpa depth, skip:",
        raw,
      );
    }
    return;
  }

  // Rebuild canonical UCI info line
  const parts: string[] = [`info depth ${p.depth}`, `multipv ${p.multipv}`];

  if (p.mate !== null) {
    parts.push(`score mate ${p.mate}`);
  } else if (p.cp !== null) {
    parts.push(`score cp ${p.cp}`);
  }

  if (p.nodes !== null) parts.push(`nodes ${p.nodes}`);
  if (p.nps !== null) parts.push(`nps ${p.nps}`);
  if (p.time !== null) parts.push(`time ${p.time}`);
  if (p.pv.length > 0) parts.push(`pv ${p.pv.join(" ")}`);

  self.postMessage(parts.join(" "));
}

/**
 * Flush engine.take_output() — jaga-jaga kalau on_info tidak dipanggil
 * sinkron (output ditumpuk di internal buffer WASM).
 */
function flushTakeOutput(): void {
  if (!engine) return;
  try {
    const buf = engine.take_output();
    if (buf && buf.trim().length > 0) {
      for (const line of buf.split("\n")) {
        const t = line.trim();
        if (t.length > 0) forwardInfoLine(t);
      }
    }
  } catch (err) {
    console.warn("[reckless.worker] take_output() error:", err);
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const msg = typeof e.data === "string" ? e.data.trim() : "";
  if (!msg) return;

  try {
    // ── uci ────────────────────────────────────────────────────────────────
    if (msg === "uci") {
      if (!engine && !isInitializing) {
        isInitializing = true;
        await init();
        engine = new Engine();
        // Single-thread: aman tanpa SharedArrayBuffer / cross-origin isolation.
        // Kalau server kamu punya COOP/COEP headers, naikkan ke 2-4.
        engine.set_threads(1);
        isInitializing = false;
      }
      self.postMessage("id name Reckless WASM");
      self.postMessage("id author codedeliveryservice & Bre");
      self.postMessage("uciok");
      return;
    }

    // ── isready ────────────────────────────────────────────────────────────
    if (msg === "isready") {
      // Tunggu init selesai (kalau race dengan "uci" yang sedang await init())
      let waited = 0;
      while (isInitializing && waited < 8000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
      }
      self.postMessage("readyok");
      return;
    }

    // ── ucinewgame ─────────────────────────────────────────────────────────
    if (msg === "ucinewgame") {
      engine?.reset();
      return;
    }

    // ── stop ───────────────────────────────────────────────────────────────
    if (msg === "stop") {
      // WASM blocking: tidak ada cara interrupt go_uci dari luar.
      // Kalau search sedang berjalan, "stop" akan di-queue dan diproses
      // SETELAH go_uci selesai — artinya stop akan muncul setelah bestmove
      // sudah dikirim, jadi efeknya no-op yang aman.
      // Kalau tidak ada search aktif, kita forward bestmove terakhir supaya
      // pemanggil tidak menunggu tanpa akhir.
      if (engine) {
        try {
          const bm = engine.last_bestmove();
          if (bm && bm.length >= 4) {
            self.postMessage(`bestmove ${bm}`);
          }
        } catch {
          /* noop */
        }
      }
      return;
    }

    // ── setoption ──────────────────────────────────────────────────────────
    if (msg.startsWith("setoption")) {
      // MultiPV: simpan buat dipakai di command "go" berikutnya
      const multiPvMatch = msg.match(/name\s+MultiPV\s+value\s+(\d+)/i);
      if (multiPvMatch) {
        lastKnownMultiPv = Math.max(1, parseInt(multiPvMatch[1], 10));
      }
      // Threads: apply langsung ke engine
      const threadsMatch = msg.match(/name\s+Threads\s+value\s+(\d+)/i);
      if (threadsMatch && engine) {
        engine.set_threads(Math.max(1, parseInt(threadsMatch[1], 10)));
      }
      // Hash: reckless tidak support Hash option — abaikan diam-diam
      return;
    }

    // ── position ───────────────────────────────────────────────────────────
    if (msg.startsWith("position")) {
      if (!engine) return;

      if (msg.includes(" fen ")) {
        // Format: "position fen <fen> [moves m1 m2 ...]"
        const afterFen = msg.split(" fen ")[1];
        if (!afterFen) return;

        const movesIdx = afterFen.indexOf(" moves ");
        const fen =
          movesIdx !== -1
            ? afterFen.slice(0, movesIdx).trim()
            : afterFen.trim();
        engine.set_position(fen);

        // Apply moves kalau ada (mis. "position fen ... moves e2e4 e7e5")
        if (movesIdx !== -1) {
          const movePart = afterFen.slice(movesIdx + 7).trim();
          if (movePart.length > 0) {
            for (const uciMove of movePart.split(/\s+/)) {
              if (uciMove.length >= 4) {
                try {
                  engine.make_move(uciMove);
                } catch {
                  console.warn("[reckless.worker] make_move gagal:", uciMove);
                }
              }
            }
          }
        }
      } else if (msg.includes("startpos")) {
        engine.set_position(START_FEN);

        const movesIdx = msg.indexOf(" moves ");
        if (movesIdx !== -1) {
          const movePart = msg.slice(movesIdx + 7).trim();
          if (movePart.length > 0) {
            for (const uciMove of movePart.split(/\s+/)) {
              if (uciMove.length >= 4) {
                try {
                  engine.make_move(uciMove);
                } catch {
                  console.warn("[reckless.worker] make_move gagal:", uciMove);
                }
              }
            }
          }
        }
      }
      return;
    }

    // ── go ─────────────────────────────────────────────────────────────────
    if (msg.startsWith("go")) {
      if (!engine) {
        console.warn("[reckless.worker] 'go' diterima tapi engine belum init");
        return;
      }

      const depthMatch = msg.match(/\bdepth (\d+)/);
      const movetimeMatch = msg.match(/\bmovetime (\d+)/);
      // Kalau "go" membawa multipv inline (jarang), pakai itu; fallback ke lastKnownMultiPv
      const inlineMultiPv = msg.match(/\bmultipv (\d+)/);
      const multiPv = inlineMultiPv
        ? Math.max(1, parseInt(inlineMultiPv[1], 10))
        : lastKnownMultiPv;

      const onInfo = (rawLine: string) => {
        if (typeof rawLine === "string" && rawLine.length > 0) {
          forwardInfoLine(rawLine);
        }
      };

      if (movetimeMatch) {
        const ms = Math.max(50, parseInt(movetimeMatch[1], 10));
        engine.go_movetime(ms, multiPv, onInfo);
      } else {
        const depth = depthMatch
          ? Math.max(1, parseInt(depthMatch[1], 10))
          : 12;
        engine.go_uci(depth, 0, multiPv, onInfo);
      }

      // Flush kalau on_info output ditumpuk di buffer internal
      flushTakeOutput();

      // Ambil bestmove setelah search selesai
      let bestMove = "";
      try {
        bestMove = engine.last_bestmove();
      } catch {
        bestMove = "";
      }

      if (bestMove && bestMove.length >= 4) {
        self.postMessage(`bestmove ${bestMove}`);
      } else {
        // Engine tidak bisa gerak (mate/stalemate atau posisi tidak valid)
        self.postMessage("bestmove (none)");
      }
      return;
    }
  } catch (err) {
    console.error("[reckless.worker] Error memproses command:", msg, err);
  }
};
