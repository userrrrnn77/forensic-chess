// src/engine/chessAnalyzer.ts
//
// Orchestrator utama analisis game catur.
//
// Flow:
//   1. Parse PGN → extract moves + FEN sequence via chess.js
//   2. Eval tiap posisi (FEN sebelum + sesudah langkah) via reckless worker
//   3. Normalisasi cp ke perspektif pemain aktif (hitam = flip sign)
//   4. Hitung cpLoss → grade via classifyMove / isBrilliantMove / isGreatMove
//   5. Aggregate accuracy per warna, move distribution, dll
//
// PENTING — Konvensi cp:
//   • Engine selalu return cp dari perspektif PUTIH (positif = putih unggul).
//   • Sebelum hitung cpLoss kita konversi ke perspektif PEMAIN AKTIF:
//       cpForActive = isWhite ? cpWhite : -cpWhite
//   • cpLoss = cpForActive(before) - cpForActive(after)
//     Nilai positif berarti langkah memperburuk posisi pemain aktif.

import { Chess } from "chess.js";
import type { MoveAnalysis, AnalysisData, PVLine, MoveGrade } from "../types";
import {
  classifyMove,
  isBrilliantMove,
  isKingHuntBrilliant,
  isGreatMove,
  detectOpening,
  detectPhase,
  evaluatePawnStructure,
  evaluateKingSafety,
  evaluatePieceActivity,
  countMaterialFromFen,
  detectTacticalThemes,
  generateExplanation,
  getAdaptiveMovetime,
  BATCH_MULTI_PV,
  TB_PIECE_THRESHOLD,
  _singleton,
  initSingleton,
  splitIntoChunks,
  workerNewGame,
  queryTablebase,
  calcAccuracy,
} from "../utils/moduleChess";
import { log } from "../utils/logger";

// ── Konstanta lokal ───────────────────────────────────────────────────────────

/** cp cap untuk posisi yang sudah winning/losing ekstrem (hindari noise) */
const CP_CAP = 1500;

/** Kalau engine return mate, map ke cp ini (dari perspektif yang diuntungkan) */
const MATE_CP = 10000;

/** Timeout per posisi (ms) sebelum eval dianggap gagal */
const EVAL_TIMEOUT_MS = 12000;

// ── Types lokal ───────────────────────────────────────────────────────────────

interface PositionEval {
  fen: string;
  cp: number; // perspektif PUTIH, sudah di-cap
  pvLines: PVLine[];
  depth: number;
  fromTablebase: boolean;
}

interface RawMove {
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  color: "white" | "black";
  moveIdx: number; // 0-based index di array moves
}

/**
 * Reasons mengapa sebuah langkah dapat grade tertentu.
 * Dipakai untuk UI "mengapa brilliant/great/dll".
 */
export interface MoveReasons {
  // Brilliant-specific
  isSacrifice: boolean; // pemain melepas material tapi posisi tetap bagus
  sacrificeType: "piece" | "exchange" | "pawn" | null;
  isOnlyGoodMove: boolean; // satu-satunya move yang mempertahankan advantage
  pvGapCp: number; // selisih cp antara PV1 dan PV2 (perspektif putih)

  // Great-specific
  isDefensiveGem: boolean; // move yang menyelamatkan posisi yang hampir kalah
  isCounterAttack: boolean; // balik menyerang saat lawan unggul

  // Konteks umum
  isForcing: boolean; // check, capture, atau ancaman mate langsung
  positionComplexity: "low" | "medium" | "high"; // seberapa complicated posisi
  labels: string[]; // label human-readable untuk UI
}

// ── Parser PGN ────────────────────────────────────────────────────────────────

/**
 * Parse PGN → array RawMove dengan FEN sebelum dan sesudah tiap langkah.
 * Throws kalau PGN invalid.
 */
export function parsePgn(pgn: string): RawMove[] {
  const chess = new Chess();

  // chess.js v1.x: loadPgn throws kalau invalid
  try {
    chess.loadPgn(pgn.trim());
  } catch (err) {
    throw new Error(`PGN invalid: ${err}`);
  }

  const history = chess.history({ verbose: true });
  if (history.length === 0) throw new Error("PGN tidak mengandung langkah");

  // Replay dari awal buat dapet FEN sequence
  chess.reset();
  const rawMoves: RawMove[] = [];

  for (let i = 0; i < history.length; i++) {
    const mv = history[i];
    const fenBefore = chess.fen();
    chess.move(mv.san);
    const fenAfter = chess.fen();

    rawMoves.push({
      san: mv.san,
      uci: mv.from + mv.to + (mv.promotion ?? ""),
      fenBefore,
      fenAfter,
      color: mv.color === "w" ? "white" : "black",
      moveIdx: i,
    });
  }

  return rawMoves;
}

// ── Eval satu posisi via worker ───────────────────────────────────────────────

/**
 * Kirim satu posisi ke worker, tunggu bestmove + info lines.
 * Return PositionEval (perspektif PUTIH).
 *
 * Strategi:
 *   - Kalau piece count ≤ TB_PIECE_THRESHOLD → coba tablebase dulu
 *   - Sinon → go movetime adaptif dengan multiPV
 */
async function evalPosition(
  worker: Worker,
  fen: string,
  moveIdx: number,
): Promise<PositionEval> {
  // ── Coba tablebase ────────────────────────────────────────────────────────
  const { pieceCount } = countMaterialFromFen(fen);
  if (pieceCount <= TB_PIECE_THRESHOLD) {
    const tb = await queryTablebase(fen);
    if (tb.category !== null) {
      // Map kategori tablebase ke cp kasar
      let tbCp = 0;
      if (tb.category === "win") tbCp = MATE_CP;
      else if (tb.category === "loss") tbCp = -MATE_CP;
      else tbCp = 0; // draw

      // Cek apakah giliran hitam (cp harus dari perspektif putih)
      const isBlackToMove = fen.includes(" b ");
      const cpWhite = isBlackToMove ? -tbCp : tbCp;

      return {
        fen,
        cp: Math.max(-CP_CAP, Math.min(CP_CAP, cpWhite)),
        pvLines: tb.bestMove
          ? [{ depth: 99, cp: cpWhite, mate: null, moves: [tb.bestMove] }]
          : [],
        depth: 99,
        fromTablebase: true,
      };
    }
  }

  // ── Eval via worker ───────────────────────────────────────────────────────
  const movetime = getAdaptiveMovetime(fen, moveIdx);

  return new Promise<PositionEval>((resolve) => {
    const pvMap = new Map<number, PVLine>(); // multipv index → PVLine terbaik
    let latestDepth = 0;
    let settled = false;

    const settle = (fallbackCp = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      worker.removeEventListener("message", handler);

      const pvLines = Array.from(pvMap.entries())
        .sort((a, b) => a[0] - b[0]) // sort by multipv index, ascending
        .map(([, pv]) => pv);

      // Ambil cp dari PV #1 (multipv=1 = best line)
      const bestPv = pvMap.get(1);
      let cp = bestPv?.cp ?? fallbackCp;

      // Handle mate score
      if (bestPv?.mate != null) {
        cp = bestPv.mate > 0 ? MATE_CP : -MATE_CP;
      }

      const isBlackToMove = fen.includes(" b ");
      if (isBlackToMove) cp = -cp;

      const normalizedPvLines = pvLines.map((pv) => ({
        ...pv,
        cp: pv.cp != null ? (isBlackToMove ? -pv.cp : pv.cp) : null,
      }));

      resolve({
        fen,
        cp: Math.max(-CP_CAP, Math.min(CP_CAP, cp)),
        pvLines: normalizedPvLines,
        depth: latestDepth,
        fromTablebase: false,
      });
    };

    const handler = (e: MessageEvent) => {
      if (settled || typeof e.data !== "string") return;
      const msg = e.data.trim();

      if (msg.startsWith("info depth")) {
        // Parse info line
        const depthM = msg.match(/\bdepth (\d+)/);
        const mpvM = msg.match(/\bmultipv (\d+)/);
        const cpM = msg.match(/\bscore cp (-?\d+)/);
        const mateM = msg.match(/\bscore mate (-?\d+)/);
        const pvM = msg.match(/\bpv (.+)$/);

        if (!depthM) return;
        const depth = parseInt(depthM[1], 10);
        const mpv = mpvM ? parseInt(mpvM[1], 10) : 1;
        const cp = cpM ? parseInt(cpM[1], 10) : null;
        const mate = mateM ? parseInt(mateM[1], 10) : null;
        const moves = pvM ? pvM[1].trim().split(/\s+/) : [];

        latestDepth = Math.max(latestDepth, depth);

        // Simpan PV terdalam per multipv index
        const existing = pvMap.get(mpv);
        if (!existing || depth >= existing.depth) {
          pvMap.set(mpv, { depth, cp, mate, moves });
        }
        return;
      }

      if (msg.startsWith("bestmove")) {
        settle();
      }
    };

    const tid = setTimeout(() => {
      log.warn("evalPosition", `timeout fen=${fen.slice(0, 20)}...`);
      settle();
    }, EVAL_TIMEOUT_MS);

    worker.addEventListener("message", handler);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go movetime ${movetime} multipv ${BATCH_MULTI_PV}`);
  });
}

// ── Normalisasi cp ────────────────────────────────────────────────────────────

/**
 * Konversi cp perspektif PUTIH → perspektif PEMAIN AKTIF.
 * FEN mengandung " w " atau " b " buat cek giliran.
 */
// function cpForActivePlayer(cpWhite: number, fen: string): number {
//   const isBlack = fen.includes(" b ");
//   return isBlack ? -cpWhite : cpWhite;
// }

// ── Cap & clamp helpers ───────────────────────────────────────────────────────

function clampCp(cp: number): number {
  return Math.max(-CP_CAP, Math.min(CP_CAP, cp));
}

/**
 * Deteksi apakah langkah ini adalah sacrifice material yang sesungguhnya.
 *
 * PENTING: sacrifice TIDAK bisa dideteksi dari fenBefore vs fenAfter satu ply,
 * karena piece yang "disacrifice" masih ada tepat sesudah langkah dimainkan —
 * itu baru hilang beberapa langkah kemudian sebagai konsekuensi (misal Bxh7
 * lalu beberapa ply kemudian bishop itu ditangkap balik). Jadi kita proyeksikan
 * sepanjang PV (predicted continuation) milik EVAL SESUDAH langkah ini,
 * bukan cuma fenAfter sesaat.
 *
 * FIX BUG #1 (sacrifice direction):
 * PV yang kita pakai berasal dari evalAfter — yaitu hasil search engine pada
 * posisi SESUDAH langkah dimainkan, di mana giliran sudah berpindah ke lawan.
 * Artinya ply pertama dari PV itu adalah balasan LAWAN, bukan lanjutan pemain
 * aktif. Replay PV ini harus dimulai dari fenAfterMove (giliran lawan), BUKAN
 * dari fenBeforeMove (giliran pemain aktif) — kalau dimulai dari fenBeforeMove,
 * uci move pertama di PV nggak valid di posisi itu (turn mismatch), chess.js
 * throw, proyeksi berhenti di ply 0, dan sacrifice nggak pernah terdeteksi
 * dengan benar.
 *
 * Pendekatan yang benar: mulai proyeksi dari fenAfterMove (posisi nyata
 * setelah langkah dimainkan), lalu apply PV continuation dari situ. Material
 * dihitung relatif terhadap material SEBELUM langkah (fenBeforeMove) supaya
 * langkah itu sendiri (mis. capture) ikut terhitung dalam delta.
 */
function detectSacrifice(
  fenBeforeMove: string,
  fenAfterMove: string, // posisi nyata setelah langkah ini dimainkan
  pvContinuationUci: string[], // PV dari evalAfter (posisi setelah langkah ini)
  isWhite: boolean,
  projectionPlies: number = 6, // proyeksi ~3 langkah penuh ke depan
): {
  isSacrifice: boolean;
  type: "piece" | "exchange" | "pawn" | null;
  netLoss: number;
} {
  // FIX BUG #5 (sacrifice attribution):
  // Versi sebelumnya ngukur delta material dari fenBeforeMove sampai posisi
  // N-ply SETELAH move ini, lalu nge-atribusikan SELURUH perubahan itu ke
  // move yang sedang dianalisis. Itu salah: kalau lawan, beberapa ply
  // kemudian, melakukan capture/promosi/exchange yang sama sekali gak
  // terkait keputusan move ini (mis. Ke2 cuma mindahin raja, gak capture
  // apa-apa, tapi 2 ply kemudian lawan promosi pion lalu promosinya
  // ketangkep balik), delta itu ke-hitung sebagai "sacrifice milik Ke2" —
  // padahal Ke2 sendiri tidak melepas material apa pun secara langsung.
  //
  // Fix: pisahkan dua hal:
  //   1) immediateDelta = delta material PERSIS pada move ini saja
  //      (fenBeforeMove → fenAfterMove, satu ply). Ini nilai material
  //      yang BENAR-BENAR dilepas oleh move itu sendiri.
  //   2) Proyeksi PV tetap dipakai, tapi HANYA untuk mengonfirmasi bahwa
  //      material yang dilepas pada immediateDelta tidak langsung
  //      dikembalikan/diimbangi balik dalam beberapa ply ke depan (jadi
  //      bukan exchange biasa yang udah seimbang instan). Proyeksi TIDAK
  //      dipakai untuk menambah delta baru — kalau immediateDelta = 0
  //      (tidak ada apa pun yang hilang pada move ini), hasilnya selalu
  //      bukan sacrifice, apa pun yang terjadi di ply-ply berikutnya.
  const beforeImmediate = countMaterialFromFen(fenBeforeMove);
  const afterImmediate = countMaterialFromFen(fenAfterMove);

  const ownBeforeImmediate = isWhite
    ? beforeImmediate.white
    : beforeImmediate.black;
  const ownAfterImmediate = isWhite
    ? afterImmediate.white
    : afterImmediate.black;
  const oppBeforeImmediate = isWhite
    ? beforeImmediate.black
    : beforeImmediate.white;
  const oppAfterImmediate = isWhite
    ? afterImmediate.black
    : afterImmediate.white;

  // Material milik pemain aktif yang hilang TEPAT pada move ini (mis. blunder
  // piece, atau material lawan yang dia tangkap dikurangi material sendiri
  // yang lenyap kalau movenya sendiri sebuah capture-trade).
  const ownImmediateLoss = ownBeforeImmediate - ownAfterImmediate;
  const oppImmediateLoss = oppBeforeImmediate - oppAfterImmediate;
  const immediateNetLoss = ownImmediateLoss - oppImmediateLoss;

  // Kalau move ini sendiri tidak melepas material apa pun secara net
  // (immediateNetLoss <= 0, mis. Ke2 yang cuma jalan biasa, atau capture
  // yang langsung untung/seimbang), ini bukan sacrifice — titik. Proyeksi
  // PV tidak relevan lagi karena apa pun yang lawan lakukan setelahnya
  // adalah keputusan lawan, bukan korban dari move ini.
  if (immediateNetLoss <= 0) {
    return { isSacrifice: false, type: null, netLoss: 0 };
  }

  // Move ini melepas material secara net. Sekarang proyeksikan PV untuk
  // cek apakah pemain aktif langsung dapat balik material itu (kompensasi
  // instan dalam beberapa ply) — kalau iya, ini exchange biasa, bukan
  // sacrifice yang genuinely "belum diganti".
  const chess = new Chess(fenAfterMove);
  let plies = 0;
  for (const uciMove of pvContinuationUci) {
    if (plies >= projectionPlies) break;
    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const promotion = uciMove.length > 4 ? uciMove.slice(4) : undefined;
    try {
      chess.move({ from, to, promotion });
    } catch {
      break; // PV move invalid di posisi simulasi, stop proyeksi di sini
    }
    plies++;
  }

  const projected = countMaterialFromFen(chess.fen());
  const ownProjected = isWhite ? projected.white : projected.black;
  const oppProjected = isWhite ? projected.black : projected.white;

  // Delta total dari SEBELUM move ini sampai akhir proyeksi, dibandingkan
  // terhadap delta immediate — supaya kita tau apakah ada kompensasi
  // tambahan yang masuk SETELAH move ini (bagian dari rencana taktis yang
  // sama), bukan aksi independen lawan yang gak nyambung ke move ini.
  const ownTotalLoss = ownBeforeImmediate - ownProjected;
  const oppTotalLoss = oppBeforeImmediate - oppProjected;
  const netLoss = ownTotalLoss - oppTotalLoss;

  // Net loss akhir minimal harus >= immediate net loss (material yang
  // dilepas move ini sendiri) — kalau proyeksi malah menunjukkan net loss
  // mengecil signifikan (banyak terkompensasi), turunkan ke tipe yang lebih
  // rendah sesuai netLoss aktual hasil proyeksi, bukan immediateNetLoss.
  if (netLoss >= 3) return { isSacrifice: true, type: "piece", netLoss };
  if (netLoss === 2) return { isSacrifice: true, type: "exchange", netLoss };
  if (netLoss >= 1) return { isSacrifice: true, type: "pawn", netLoss };
  return { isSacrifice: false, type: null, netLoss: 0 };
}

// ── Build MoveAnalysis dari dua eval ─────────────────────────────────────────

function buildMoveAnalysis(
  raw: RawMove,
  evalBefore: PositionEval,
  evalAfter: PositionEval,
): MoveAnalysis {
  // cp dari perspektif pemain yang BERGERAK di langkah ini
  // fenBefore = posisi sebelum langkah → pemain aktif = yang bergerak
  // cp dari perspektif PUTIH (engine convention)
  const cpWhiteBefore = evalBefore.cp;
  const cpWhiteAfter = evalAfter.cp;

  // Konversi ke perspektif pemain yang bergerak di langkah ini
  // Pemain yang bergerak = active player di fenBefore
  const isBlackMove = raw.fenBefore.includes(" b ");
  const sign = isBlackMove ? -1 : 1;
  // fenAfter = posisi setelah langkah → giliran ganti, jadi flip lagi
  // cpAfter harus dari perspektif pemain yang BARU SAJA bergerak:
  //   evalAfter.cp = perspektif putih → konversi ke perspektif pemain yang bergerak
  //   = cpForActivePlayer(evalAfter.cp, fenBefore) karena pemain yang bergerak
  //     sama dengan yang aktif di fenBefore
  // Konversi: perspektif putih → perspektif pemain yang baru bergerak

  const cpBefore = clampCp(sign * cpWhiteBefore);
  const cpAfter = clampCp(sign * cpWhiteAfter);

  const cpLoss = Math.max(0, cpBefore - cpAfter);

  // PV lines dari perspektif PUTIH (untuk isBrilliantMove / isGreatMove)
  // yang butuh cp dari perspektif putih untuk konsistensi perbandingan
  const pvLinesBeforeWhite: PVLine[] = evalBefore.pvLines;
  const pvLinesAfterWhite: PVLine[] = evalAfter.pvLines;

  // Grade awal
  let grade: MoveGrade = classifyMove(
    cpLoss,
    pvLinesBeforeWhite,
    raw.fenBefore,
  );

  const isWhiteMove = raw.color === "white";
  const pvContinuation = evalAfter.pvLines[0]?.moves ?? [];
  const sacrifice = detectSacrifice(
    raw.fenBefore,
    raw.fenAfter,
    pvContinuation,
    isWhiteMove,
  );

  // FIX: jangan gate ke grade === "best" — sacrifice/only-move bisa punya
  // cpLoss yang ke-classify "excellent"/"good" duluan (krn cpLoss sacrifice
  // gak selalu <15), sehingga brilliant/great gak pernah ke-cek sama sekali.
  // isBrilliantMove & isGreatMove sudah punya cpLoss check sendiri di dalam,
  // jadi cek independen dari classifyMove, baru override grade-nya.
  const brilliantSacrificeCheck = isBrilliantMove(
    cpLoss,
    evalAfter.cp,
    pvLinesAfterWhite,
    sacrifice.isSacrifice,
  );
  // Jalur tambahan: forcing check + king lawan dipaksa keluar + only-good-move
  // (PV diambil dari evalBefore — milik pemain aktif sendiri, bukan PV lawan).
  // Pass isSacrifice supaya settled-mate guard bisa dikecualikan untuk
  // sacrifice nyata (Bxf7+, exf2+) tapi tidak untuk capture non-sacrifice
  // (Qxd1+ ambil ratu gratis).
  const brilliantKingHuntCheck = isKingHuntBrilliant(
    raw.san,
    cpLoss,
    cpWhiteBefore,
    pvLinesBeforeWhite,
    raw.fenBefore,
    raw.fenAfter,
    sacrifice.isSacrifice,
  );
  const brilliantCheck = brilliantSacrificeCheck || brilliantKingHuntCheck;
  // Pass cpWhiteBefore supaya isGreatMove bisa guard posisi settled-mate —
  // mencegah move kasual di +M sequence mendapat "great" hanya karena pv1=null.
  const greatCheck = isGreatMove(cpLoss, pvLinesBeforeWhite, cpWhiteBefore);

  log.info(
    "buildMoveAnalysis",
    `${raw.san} (idx=${raw.moveIdx}, color=${raw.color}):`,
    `cpLoss=${cpLoss}`,
    `cpBefore=${cpBefore}`,
    `cpAfter=${cpAfter}`,
    `evalAfter.cp(white)=${evalAfter.cp}`,
    `isSacrifice=${sacrifice.isSacrifice}`,
    `sacrificeType=${sacrifice.type}`,
    `netLoss=${sacrifice.netLoss}`,
    `pvAfterWhite=${JSON.stringify(pvLinesAfterWhite.slice(0, 2).map((p) => p?.cp))}`,
    `pvBeforeWhite=${JSON.stringify(pvLinesBeforeWhite.slice(0, 2).map((p) => p?.cp))}`,
    `brilliantSacrificeCheck=${brilliantSacrificeCheck}`,
    `brilliantKingHuntCheck=${brilliantKingHuntCheck}`,
    `greatCheck=${greatCheck}`,
    `classifyMoveGrade=${grade}`,
  );

  // FIX Bug 2 & 3: grade override tidak berjalan dengan benar.
  // Root cause: `grade` sudah di-set oleh `classifyMove` di atas, lalu
  // blok if/else-if di bawah seharusnya meng-override-nya. Tapi kalau
  // ada early-return atau kondisi lain yang bypass blok ini, grade tetap
  // dari classifyMove. Gw pindahkan override ke setelah log supaya urutan
  // eksekusi jelas dan tidak ada yang bisa bypass-nya.
  //
  // Logika yang benar:
  //   1. brilliant (sacrifice OR king-hunt) → override ke "brilliant"
  //   2. kalau tidak brilliant tapi greatCheck → override ke "great"
  //   3. kalau tidak keduanya → pakai grade dari classifyMove
  //
  // PENTING: greatCheck pakai pvLinesBeforeWhite (PV pemain aktif sebelum
  // move), bukan pvLinesAfterWhite. Ini sudah benar di isGreatMove.
  // Masalah sebelumnya: null-guard tidak ada, jadi pv1=null ?? 0 = 0,
  // gap menjadi |0 - pv2|. Untuk Bxf7+ (pv1=null, pv2=-424), gap = 424 > 200
  // → greatCheck=true benar. Tapi grade tidak ke-assign karena blok override
  // mungkin tidak tercapai. Fix: pastikan assignment selalu terjadi.
  if (brilliantCheck) {
    grade = "brilliant";
  } else if (greatCheck) {
    grade = "great";
  }
  // else: grade tetap dari classifyMove di atas — tidak perlu diubah

  log.info(
    "buildMoveAnalysis",
    `${raw.san} FINAL grade=${grade} (brilliantCheck=${brilliantCheck}, greatCheck=${greatCheck})`,
  );

  // Metadata posisi
  const phase = detectPhase(raw.fenBefore);
  const pawnScore = evaluatePawnStructure(raw.fenBefore);
  const kingScore = evaluateKingSafety(raw.fenBefore);
  const pieceScore = evaluatePieceActivity(raw.fenBefore);
  const { balance: materialBalance } = countMaterialFromFen(raw.fenBefore);
  const tacticalThemes = detectTacticalThemes(cpLoss, cpBefore, cpAfter);
  const isTactical = tacticalThemes.length > 0;
  const explanation = generateExplanation(
    grade,
    cpLoss,
    phase,
    tacticalThemes,
    pawnScore,
    kingScore,
    pieceScore,
    sacrifice.type,
  );

  // Best move suggestion = move #1 dari PV evalBefore (engine's top choice)
  const bestMoveSuggestion = evalBefore.pvLines[0]?.moves[0] ?? null;

  return {
    moveIdx: raw.moveIdx,
    move: raw.san,
    fen: raw.fenBefore,
    cpBefore,
    cpAfter,
    cpLoss,
    grade,
    isBrilliant: grade === "brilliant",
    isGreat: grade === "great",
    isBest: grade === "best" || grade === "brilliant" || grade === "great",
    bestMoveSuggestion,
    phase,
    materialBalance,
    pawnStructureScore: pawnScore,
    kingSafetyScore: kingScore,
    pieceActivityScore: pieceScore,
    isTactical,
    tacticalTheme: tacticalThemes,
    explanation,
  };
}

function buildDistribution(
  analyses: MoveAnalysis[],
  color: "white" | "black",
): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const m of analyses) {
    const isWhite = m.moveIdx % 2 === 0;
    if (color === "white" ? !isWhite : isWhite) continue;
    dist[m.grade] = (dist[m.grade] ?? 0) + 1;
  }
  return dist;
}

// ── Critical moments detector ─────────────────────────────────────────────────

/**
 * Deteksi indeks langkah di mana terjadi swing eval besar (±150cp atau lebih).
 */
function findCriticalMoments(analyses: MoveAnalysis[]): number[] {
  return analyses
    .filter((m) => m.cpLoss >= 150 || m.isTactical)
    .map((m) => m.moveIdx);
}

// ── Best accuracy streak ──────────────────────────────────────────────────────

function findBestAccuracyStreak(analyses: MoveAnalysis[]): {
  color: "white" | "black";
  length: number;
  from: number;
} {
  let best = { color: "white" as "white" | "black", length: 0, from: 0 };

  for (const color of ["white", "black"] as const) {
    const moves = analyses.filter((m) =>
      color === "white" ? m.moveIdx % 2 === 0 : m.moveIdx % 2 !== 0,
    );
    let streak = 0;
    let streakStart = 0;
    for (let i = 0; i < moves.length; i++) {
      const g = moves[i].grade;
      if (
        g === "brilliant" ||
        g === "great" ||
        g === "best" ||
        g === "excellent"
      ) {
        if (streak === 0) streakStart = moves[i].moveIdx;
        streak++;
        if (streak > best.length) {
          best = { color, length: streak, from: streakStart };
        }
      } else {
        streak = 0;
      }
    }
  }
  return best;
}

// ── Eval semua posisi (parallel batch) ───────────────────────────────────────

/**
 * Eval semua FEN unik yang dibutuhkan.
 * Tiap game butuh eval N+1 posisi (sebelum langkah 1 sampai setelah langkah N).
 * Distribusikan ke PARALLEL_WORKERS batch workers.
 */
async function evalAllPositions(
  fens: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, PositionEval>> {
  const result = new Map<string, PositionEval>();

  const uniqueFens = [...new Set(fens)];
  const total = uniqueFens.length;
  let done = 0;

  // Selalu pakai singleton — jangan spawn worker baru di sini
  if (!_singleton.batchWorkersPromise) {
    throw new Error("Singleton belum init — panggil initSingleton dulu");
  }
  const workers = await _singleton.batchWorkersPromise;

  if (workers.length === 0) throw new Error("Tidak ada batch worker tersedia");

  await Promise.all(workers.map((w) => workerNewGame(w)));

  const chunks = splitIntoChunks(uniqueFens, workers.length);

  await Promise.all(
    chunks.map(async ({ items, startIdx }, chunkIndex) => {
      const worker = workers[chunkIndex % workers.length];

      for (let i = 0; i < items.length; i++) {
        const fen = items[i];
        const cached = _singleton.evalCache.get(fen);
        if (cached) {
          result.set(fen, {
            fen,
            cp: cached.cp,
            pvLines: cached.pvLines,
            depth: cached.pvLines[0]?.depth ?? 0,
            fromTablebase: cached.pvLines[0]?.depth === 99,
          });
          done++;
          onProgress?.(done, total);
          continue;
        }

        try {
          const ev = await evalPosition(worker, fen, startIdx + i);
          result.set(fen, ev);
          _singleton.evalCache.set(fen, { cp: ev.cp, pvLines: ev.pvLines });
        } catch (err) {
          log.warn(
            "evalAllPositions",
            `eval gagal untuk fen=${fen.slice(0, 20)}`,
            err,
          );
          result.set(fen, {
            fen,
            cp: 0,
            pvLines: [],
            depth: 0,
            fromTablebase: false,
          });
        }

        done++;
        onProgress?.(done, total);
      }
    }),
  );

  return result;
}

// ── Game phase distribution ───────────────────────────────────────────────────

function calcGamePhases(analyses: MoveAnalysis[]): {
  opening: number;
  middlegame: number;
  endgame: number;
} {
  const counts = { opening: 0, middlegame: 0, endgame: 0 };
  for (const m of analyses) counts[m.phase]++;
  const total = analyses.length || 1;
  return {
    opening: Math.round((counts.opening / total) * 100),
    middlegame: Math.round((counts.middlegame / total) * 100),
    endgame: Math.round((counts.endgame / total) * 100),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  /** Dipanggil saat progress eval berubah (0–1) */
  onProgress?: (progress: number) => void;
  /** Override depth (default TARGET_DEPTH dari moduleChess) */
  depth?: number;
}

/**
 * Analisis satu game dari PGN.
 * Return AnalysisData lengkap.
 *
 * Cara pakai:
 *   const result = await analyzeGame(pgn, { onProgress: (p) => setProgress(p) });
 */
export async function analyzeGame(
  pgn: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisData> {
  const { onProgress } = options;

  // 1. Parse PGN
  const rawMoves = parsePgn(pgn);
  if (rawMoves.length === 0) throw new Error("Game tidak mengandung langkah");

  // 2. Kumpulkan semua FEN yang perlu di-eval
  //    = fenBefore tiap langkah + fenAfter langkah terakhir
  const allFens: string[] = [];
  for (const m of rawMoves) {
    allFens.push(m.fenBefore);
  }
  // Tambah fenAfter langkah terakhir
  allFens.push(rawMoves[rawMoves.length - 1].fenAfter);

  // 3. Pastikan singleton/worker ready
  await new Promise<void>((resolve) => {
    initSingleton(() => resolve());
    // Kalau sudah ready, initSingleton langsung panggil callback
  });

  // 4. Eval semua posisi
  const evalMap = await evalAllPositions(allFens, (done, total) => {
    onProgress?.(done / total);
  });

  // 5. Build MoveAnalysis per langkah
  const moveAnalyses: MoveAnalysis[] = [];

  for (const raw of rawMoves) {
    const evBefore = evalMap.get(raw.fenBefore);
    const evAfter = evalMap.get(raw.fenAfter);

    if (!evBefore || !evAfter) {
      log.warn(
        "analyzeGame",
        `eval missing untuk move ${raw.moveIdx} (${raw.san})`,
      );
      continue;
    }

    moveAnalyses.push(buildMoveAnalysis(raw, evBefore, evAfter));
  }

  // 6. Opening detection — pakai SAN sequence
  const sanMoves = rawMoves.map((m) => m.san);
  const { name: openingName, eco: openingEco } = detectOpening(sanMoves);

  // 7. Accuracy
  const whiteAccuracy = calcAccuracy(moveAnalyses, "white");
  const blackAccuracy = calcAccuracy(moveAnalyses, "black");
  const overallAccuracy =
    Math.round(((whiteAccuracy + blackAccuracy) / 2) * 10) / 10;

  // 8. Move distribution per warna
  const whiteDist = buildDistribution(moveAnalyses, "white");
  const blackDist = buildDistribution(moveAnalyses, "black");

  // 9. Metadata tambahan
  const criticalMoments = findCriticalMoments(moveAnalyses);
  const bestAccuracyStreak = findBestAccuracyStreak(moveAnalyses);
  const gamePhases = calcGamePhases(moveAnalyses);

  onProgress?.(1);

  return {
    accuracy: overallAccuracy,
    accuracyByColor: { white: whiteAccuracy, black: blackAccuracy },
    moveDistribution: { white: whiteDist, black: blackDist },
    moveAnalyses,
    openingName,
    openingEco,
    gamePhases,
    criticalMoments,
    bestAccuracyStreak,
  };
}

/**
 * Versi streaming — callback dipanggil setiap langkah selesai di-analisis.
 * Berguna buat update UI secara incremental.
 */
export async function analyzeGameStreaming(
  pgn: string,
  onMove: (analysis: MoveAnalysis, idx: number, total: number) => void,
  options: AnalyzeOptions = {},
): Promise<AnalysisData> {
  const { onProgress } = options;
  const rawMoves = parsePgn(pgn);

  await new Promise<void>((resolve) => {
    initSingleton(() => resolve());
  });

  const allFens: string[] = rawMoves.map((m) => m.fenBefore);
  allFens.push(rawMoves[rawMoves.length - 1].fenAfter);

  const evalMap = await evalAllPositions(allFens, (done, total) => {
    // Progress eval = 80% dari total progress
    onProgress?.((done / total) * 0.8);
  });

  const moveAnalyses: MoveAnalysis[] = [];
  const total = rawMoves.length;

  for (let i = 0; i < rawMoves.length; i++) {
    const raw = rawMoves[i];
    const evBefore = evalMap.get(raw.fenBefore);
    const evAfter = evalMap.get(raw.fenAfter);

    if (!evBefore || !evAfter) continue;

    const analysis = buildMoveAnalysis(raw, evBefore, evAfter);
    moveAnalyses.push(analysis);
    onMove(analysis, i, total);

    // Progress build = 80-100%
    onProgress?.(0.8 + (i / total) * 0.2);
  }

  const sanMoves = rawMoves.map((m) => m.san);
  const { name: openingName, eco: openingEco } = detectOpening(sanMoves);

  const whiteAccuracy = calcAccuracy(moveAnalyses, "white");
  const blackAccuracy = calcAccuracy(moveAnalyses, "black");

  onProgress?.(1);

  return {
    accuracy: Math.round(((whiteAccuracy + blackAccuracy) / 2) * 10) / 10,
    accuracyByColor: { white: whiteAccuracy, black: blackAccuracy },
    moveDistribution: {
      white: buildDistribution(moveAnalyses, "white"),
      black: buildDistribution(moveAnalyses, "black"),
    },
    moveAnalyses,
    openingName,
    openingEco,
    gamePhases: calcGamePhases(moveAnalyses),
    criticalMoments: findCriticalMoments(moveAnalyses),
    bestAccuracyStreak: findBestAccuracyStreak(moveAnalyses),
  };
}
