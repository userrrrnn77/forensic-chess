// src/utils/moduleChess.ts
//
// Berisi:
//   • Konstanta konfigurasi engine & analisis
//   • Singleton state (liveWorker, batchWorkers, evalCache, workerHealth)
//   • Helper matematika (cpToWinPct, winPctToAccuracy)
//   • Evaluator posisi (pawn structure, king safety, piece activity, material)
//   • Classifier langkah (classifyMove, isBrilliantMove, isGreatMove)
//   • Detector opening, fase game, tema taktis
//   • Tablebase query (Lichess Syzygy API)
//   • Factory worker (createReadyWorker, initBatchWorker)
//   • Handshake helpers (workerNewGame, workerHandshake)
//   • Utilitas (splitIntoChunks, initSingleton)
//   • calcAccuracy — dipindah dari chessAnalyzer.ts, sekarang harmonic mean
//
// CHANGES vs original:
//   FIX #1 — isBrilliantMove sekarang terima pvLinesAfterWhite (dari evalAfter)
//   FIX #2 — Brilliant tidak lagi wajib sacrifice; ada jalur quiet only-move
//   FIX #3a — classifyMove: forced lebih ketat (gap>400 AND pv2<50 absolut)
//   FIX #3b — isGreatMove: gap threshold naik 120→200
//   FIX #4  — calcAccuracy: harmonic mean, lebih menghukum blunder tunggal

import type {
  EvalResult,
  MoveAnalysis,
  MoveGrade,
  PVLine,
  WorkerHealth,
} from "../types";
import { log } from "../utils/logger";
import { Chess } from "chess.js";

// ── Konstanta engine ─────────────────────────────────────────────────────────

export const TARGET_DEPTH = 18;
export const MULTI_PV = 5;
export const LIVE_MULTI_PV = 5;
export const BATCH_MULTI_PV = 4;
export const PARALLEL_WORKERS = 4;

export const MOVETIME_OPENING = 500;
export const MOVETIME_MIDDLEGAME = 800;
export const MOVETIME_ENDGAME = 600;
export const MOVETIME_TRIVIAL = 300;

export const TB_PIECE_THRESHOLD = 7;
export const STOP_GRACE_MS = 800;
export const ZOMBIE_THRESHOLD = 3;
export const MAX_RETRIES = 0;

export const WORKER_INIT_TIMEOUT_MS = 8000;
export const READYOK_TIMEOUT_MS = 3000;
export const INIT_READYOK_TIMEOUT_MS = 15000;

// ── Singleton state ───────────────────────────────────────────────────────────

export const _singleton: {
  liveWorker: Worker | null;
  batchWorkersPromise: Promise<Worker[]> | null;
  initialized: boolean;
  isReady: boolean;
  evalCache: Map<string, EvalResult>;
  workerHealth: Map<number, WorkerHealth>;
} = {
  liveWorker: null,
  batchWorkersPromise: null,
  initialized: false,
  isReady: false,
  evalCache: new Map(),
  workerHealth: new Map(),
};

// ── Worker factory helper ─────────────────────────────────────────────────────

function spawnRecklessWorker(): Worker {
  return new Worker(new URL("../engine/reckless.worker.ts", import.meta.url), {
    type: "module",
  });
}

// ── Matematika eval ───────────────────────────────────────────────────────────

export function cpToWinPct(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function winPctToAccuracy(wBefore: number, wAfter: number): number {
  const delta = Math.max(0, wBefore - wAfter);
  return Math.max(
    0,
    Math.min(100, 103.1668 * Math.exp(-0.04354 * delta) - 3.1669),
  );
}

// ── Evaluator posisi ──────────────────────────────────────────────────────────

export function countMaterialFromFen(fen: string): {
  white: number;
  black: number;
  total: number;
  balance: number;
  pieceCount: number;
} {
  const pieceValues: Record<string, number> = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9,
    P: 1,
    N: 3,
    B: 3,
    R: 5,
    Q: 9,
  };
  const board = fen.split(" ")[0];
  let white = 0,
    black = 0,
    pieceCount = 0;
  for (const ch of board) {
    if (/[pnbrqkPNBRQK]/.test(ch)) pieceCount++;
    const val = pieceValues[ch];
    if (!val) continue;
    if (ch === ch.toUpperCase()) white += val;
    else black += val;
  }
  return {
    white,
    black,
    total: white + black,
    balance: white - black,
    pieceCount,
  };
}

export function getAdaptiveMovetime(fen: string, halfMoveIdx: number): number {
  if (halfMoveIdx < 6) return MOVETIME_OPENING;
  const { total, pieceCount } = countMaterialFromFen(fen);
  if (pieceCount <= TB_PIECE_THRESHOLD) return MOVETIME_TRIVIAL;
  if (total <= 20) return MOVETIME_ENDGAME;
  return MOVETIME_MIDDLEGAME;
}

export function detectPhase(fen: string): "opening" | "middlegame" | "endgame" {
  const { total } = countMaterialFromFen(fen);
  const moveNum = parseInt(fen.split(" ")[5] || "1", 10);
  if (moveNum <= 10 && total >= 60) return "opening";
  if (total <= 20) return "endgame";
  return "middlegame";
}

export function evaluatePawnStructure(fen: string): number {
  const board = fen.split(" ")[0];
  const rows = board.split("/");
  const files = Array(8)
    .fill(0)
    .map(() => ({ w: 0, b: 0 }));
  let score = 0;
  for (let r = 0; r < 8; r++) {
    let col = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        col += parseInt(ch, 10);
        continue;
      }
      if (ch === "P") files[col].w++;
      else if (ch === "p") files[col].b++;
      col++;
    }
  }
  for (let f = 0; f < 8; f++) {
    if (files[f].w > 1) score -= (files[f].w - 1) * 15;
    if (files[f].b > 1) score += (files[f].b - 1) * 15;
    const leftEmpty = f === 0 || files[f - 1].w === 0;
    const rightEmpty = f === 7 || files[f + 1].w === 0;
    if (files[f].w > 0 && leftEmpty && rightEmpty) score -= 10;
    const leftEmptyB = f === 0 || files[f - 1].b === 0;
    const rightEmptyB = f === 7 || files[f + 1].b === 0;
    if (files[f].b > 0 && leftEmptyB && rightEmptyB) score += 10;
  }
  return Math.max(-100, Math.min(100, score));
}

export function evaluateKingSafety(fen: string): number {
  const board = fen.split(" ")[0];
  const rows = board.split("/");
  function findKing(color: "w" | "b"): [number, number] {
    const target = color === "w" ? "K" : "k";
    for (let r = 0; r < 8; r++) {
      let col = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) {
          col += parseInt(ch, 10);
          continue;
        }
        if (ch === target) return [r, col];
        col++;
      }
    }
    return [-1, -1];
  }
  const [wKr, wKc] = findKing("w");
  const [bKr, bKc] = findKing("b");
  let score = 0;
  if (wKr === 7 && (wKc === 6 || wKc === 2)) score += 30;
  if (bKr === 0 && (bKc === 6 || bKc === 2)) score -= 30;
  if (wKr >= 3 && wKr <= 5) score -= 25;
  if (bKr >= 3 && bKr <= 5) score += 25;
  return Math.max(-100, Math.min(100, score));
}

export function evaluatePieceActivity(fen: string): number {
  const board = fen.split(" ")[0];
  const rows = board.split("/");
  let score = 0;
  for (let r = 0; r < 8; r++) {
    let col = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        col += parseInt(ch, 10);
        continue;
      }
      const isCenter = r >= 3 && r <= 4 && col >= 3 && col <= 4;
      const isExtCenter = r >= 2 && r <= 5 && col >= 2 && col <= 5;
      if (/[NBRQ]/.test(ch)) score += isCenter ? 20 : isExtCenter ? 8 : 0;
      else if (/[nbrq]/.test(ch)) score -= isCenter ? 20 : isExtCenter ? 8 : 0;
      col++;
    }
  }
  return Math.max(-100, Math.min(100, score));
}

// ── Classifier langkah ────────────────────────────────────────────────────────

export function detectTacticalThemes(
  cpLoss: number,
  cpBefore: number,
  cpAfter: number,
): string[] {
  const themes: string[] = [];
  const swing = Math.abs(cpAfter - cpBefore);
  if (swing > 300) themes.push("Tactical Blow");
  if (cpLoss > 200) themes.push("Missed Tactic");
  if (Math.abs(cpBefore) < 50 && Math.abs(cpAfter) > 200)
    themes.push("Game-Changer");
  if (cpLoss === 0 && Math.abs(cpAfter) > 500) themes.push("Forcing Line");
  return themes;
}

export function generateExplanation(
  grade: MoveGrade,
  cpLoss: number,
  phase: string,
  themes: string[],
  pawnScore: number,
  kingScore: number,
  pieceScore: number,
  sacrificeType: "piece" | "exchange" | "pawn" | null = null,
): string {
  const themeStr = themes.length ? ` [${themes.join(", ")}]` : "";
  switch (grade) {
    case "brilliant": {
      const sacText = sacrificeType
        ? `sacrifices ${sacrificeType === "piece" ? "a piece" : sacrificeType === "exchange" ? "material in an exchange" : "a pawn"}`
        : "finds the only winning/saving continuation";
      return `Brilliant!!${themeStr} — A deeply creative move that ${sacText} and creates complications the opponent cannot navigate.`;
    }
    case "great":
      return `Great move!${themeStr} — An excellent response that finds a strong continuation. The engine agrees this is among the top choices.`;
    case "best":
      return `Best move.${themeStr} — Optimal play, matching the engine's top recommendation. ${phase === "endgame" ? "In the endgame, precision is everything." : "Maintains the advantage effectively."}`;
    case "good":
      return `Good move.${themeStr} — A solid, reasonable choice. Minor inaccuracy of ${cpLoss}cp — the position is still well maintained.`;
    case "inaccuracy":
      return `Inaccuracy (?!)${themeStr} — A suboptimal move costing ~${cpLoss}cp. ${pieceScore < -20 ? "Piece activity suffered." : "A better continuation was available."}`;
    case "mistake":
      return `Mistake (?)${themeStr} — Significant error costing ~${cpLoss}cp. ${kingScore < -20 ? "King safety was compromised." : pawnScore < -20 ? "Pawn structure weakened unnecessarily." : "A stronger move was clearly available."}`;
    case "blunder":
      return `Blunder (??)${themeStr} — A serious error costing ~${cpLoss}cp that may be decisive. ${themes.includes("Missed Tactic") ? "A tactical resource was completely missed." : "The position swings dramatically in the opponent's favor."}`;
    case "forced":
      return `Forced move. Only legal or clearly dominant continuation in this position.`;
    case "miss":
      return `Missed opportunity. The player had a much stronger move available but chose a passive continuation.`;
    default:
      return "Move analyzed.";
  }
}

// ── FIX #3a: classifyMove — forced lebih ketat ────────────────────────────────
//
// pv2 dibandingkan secara absolut, bukan langsung dibandingkan ke +50.
// Soalnya pv2 bisa negatif (lawan malah lebih unggul di alternatif kedua),
// dan itu BUKAN tanda forced — itu tanda alternatif kedua jelek di kedua arah.
// Yang kita mau cek: apakah pv2 "sekitar netral" (deket 0), bukan "di bawah 50".
//
// PERUBAHAN dari versi sebelumnya: `length <= 1` TIDAK lagi otomatis forced.
// PV cuma 1 line di pipeline batch ini jauh lebih sering berarti "MultiPV
// gagal / worker timeout / data kurang" daripada "posisi benar-benar forced
// (1 legal move)". Kalau di-treat sebagai forced, false positive-nya lebih
// mahal daripada kehilangan label forced di kasus genuinely-forced (yang
// toh masih ke-grade benar lewat cpLoss, cuma kehilangan label saja).
//
// Catatan: deteksi forced yang akurat (dari jumlah legal move di posisi)
// butuh akses FEN, yang nggak ada di signature function ini — itu enhancement
// terpisah kalau dibutuhkan nanti.

export function classifyMove(
  cpLoss: number,
  pvLinesWhite: PVLine[],
  fen: string,
): MoveGrade {
  const legalMoveCount = new Chess(fen).moves().length;
  const isOnlyLegalMove = legalMoveCount === 1;

  const isForcedByGap = (() => {
    if (pvLinesWhite.length < 2) return false;
    const pv1cp = pvLinesWhite[0]?.cp ?? null;
    const pv2cp = pvLinesWhite[1]?.cp ?? null;
    // FIX: null-guard konsisten. Mate (null) selalu lebih baik dari cp apapun.
    // Kalau pv1=null (mate) dan pv2=angka, gap adalah "infinite" → forced.
    // Kalau keduanya null, tidak bisa judge → false.
    if (pv1cp === null && pv2cp !== null) return Math.abs(pv2cp) < 50;
    if (pv1cp === null || pv2cp === null) return false;
    const gap = Math.abs(pv1cp - pv2cp);
    return gap > 400 && Math.abs(pv2cp) < 50;
  })();

  const isForced = isOnlyLegalMove || isForcedByGap;

  if (isForced && cpLoss < 15) return "forced";
  if (cpLoss < 15) return "best";
  if (cpLoss < 30) return "excellent";
  // FIX #9 — threshold good dinaikkan 70 → 100, inaccuracy 150 → 200.
  // Di fase opening, engine sering swing ±70-100cp karena depth terbatas
  // dan posisi masih fluid — banyak solid moves kelihatan cpLoss=70-99
  // padahal praktisnya masih fine. Threshold lama terlalu ketat.
  if (cpLoss < 100) return "good";
  if (cpLoss < 200) return "inaccuracy";
  if (cpLoss < 350) return "mistake";
  return "blunder";
}

// ── FIX #6 + #7 + #9: isKingHuntBrilliant ───────────────────────────────────
//
// Kasus seperti exf2+ / fxg1=N+ bukan material sacrifice (lihat detectSacrifice
// yang sudah di-fix — immediateNetLoss-nya malah negatif/untung material).
// Tapi mereka tetap bisa "brilliant" lewat jalur lain: forcing check yang
// memaksa raja lawan keluar dari shelter-nya, DAN merupakan satu-satunya
// cara pemain aktif menjaga keunggulan besarnya.
//
// FIX #9 — Tambah parameter prevCpWhiteBefore untuk bedain "mating pattern
// capture" (Bxf7+) dari "eksekusi settled sequence" (Qxd1+):
//
//   Problem sebelumnya: Bxf7+ dan Qxd1+ terlihat identik dari data lokal —
//   keduanya settled (cpBefore=±1500), isCapture=true, pv1=null, pv2=finite.
//   Tidak bisa dibedakan tanpa konteks move sebelumnya.
//
//   Solusi: prevCpWhiteBefore = cpBeforeWhite dari move idx-2 (dua posisi
//   sebelumnya, perspektif putih). Ini tersedia di evalMap di buildMoveAnalysis
//   karena evalMap menyimpan semua FEN.
//
//   Logic:
//     - Bxf7+ (idx=10): prevCp = cpAfter Bxd1 (idx=9) → +1500 (material blunder)
//       TAPI posisi idx=8 (Nxe5 sebelum Bxd1) adalah cpBefore untuk Bxd1 → ~+87
//       Jadi prevCpWhiteBefore untuk Bxf7+ = cpBefore move idx=8 = ~+87 → NOT settled
//     - Qxd1+ (idx=17): prevCpWhiteBefore = cpBefore move idx=15 (Bg4+) = ~-590
//       → sudah deep negative (lawan menang), posisi sudah dalam mating sequence
//
//   Cara akses: di buildMoveAnalysis, lookup rawMoves[idx-2].fenBefore dari evalMap.
//   Null-safe: kalau idx < 2, tidak ada prevMove → pass null → tidak ada brilliant
//   dari path ini (fine, early-game moves jarang brilliant lewat jalur ini).
export function isKingHuntBrilliant(
  san: string,
  cpLoss: number,
  cpBeforeWhite: number, // eval SEBELUM move ini, perspektif putih
  pvLinesBeforeWhite: PVLine[], // dari evalBefore — PV milik pemain aktif
  fenBeforeMove: string,
  _fenAfterMove: string, // reserved untuk future extension
  isSacrifice: boolean = false, // apakah move ini melepas material secara net
  prevCpWhiteBefore: number | null = null, // cpBefore move idx-2, perspektif putih
): boolean {
  // 1) Harus forcing: check atau checkmate
  const isCheck = san.includes("+") || san.includes("#");
  if (!isCheck) return false;

  // 2) cpLoss harus kecil — move ini tidak boleh merugikan posisi sendiri.
  //    Toleransi 30cp supaya king-hunt yang evaluasinya underestimate sedikit
  //    di depth terbatas tetap terdeteksi.
  if (cpLoss > 30) return false;

  // 3) Settled-mate guard.
  //
  //    Kalau posisi sebelum move ini sudah forced mate (|cpBeforeWhite| >= 1490),
  //    sebagian besar check/capture adalah eksekusi sequence yang sudah inevitable.
  //
  //    Tiga exception yang tetap bisa brilliant:
  //
  //    a) isSacrifice=true: pemain aktif melepas material untuk membangun
  //       mating net (exf2+, fxg1=N+). Kreasi aktif, bukan eksekusi.
  //
  //    b) "Mating pattern capture" (Bxf7+, Legal's Mate, dll):
  //       Capture check di posisi yang baru SAJA menjadi settled — artinya
  //       dua move sebelumnya posisi belum settled. Move ini sendiri yang
  //       aktif menciptakan forced mate, bukan sekadar melanjutkan sequence.
  //       Deteksi: |prevCpWhiteBefore| < 1490 — dua move sebelumnya posisi
  //       BELUM settled, jadi transisi ke +M terjadi di sekitar move ini.
  //
  //    c) Tidak settled sama sekali (!isSettledMate): kasus normal,
  //       lolos langsung ke only-good-move check.
  //
  //    Qxd1+ diblok karena: settled=true, isSacrifice=false, dan
  //    prevCpWhiteBefore=-590 (already deep in mating sequence) → |prev|<1490
  //    tapi konteksnya berbeda... wait, kita butuh cek lebih hati-hati.
  //
  //    Re-analisis dengan data log baru:
  //      Bxf7+ (idx=10): prevCpWhiteBefore = cp dari fenBefore idx=8 (Nxe5)
  //        = +87. |87| < 1490 → "recently settled" → exception b → brilliant ✓
  //      Qxd1+ (idx=17): prevCpWhiteBefore = cp dari fenBefore idx=15 (Bg4+)
  //        = -590 (hitam sudah menang besar). |590| < 1490 secara angka...
  //        tapi ini bukan "recently became settled" — ini posisi yang sudah
  //        deep losing untuk putih sejak lama.
  //
  //    Problem: |prevCp| < 1490 tidak cukup bedain keduanya karena -590 juga < 1490.
  //    Solusi lebih presisi: "mating pattern capture" valid hanya kalau
  //    prevCpWhiteBefore berada di zona "winning tapi belum mate" dari SISI
  //    pemain yang sedang bergerak. Untuk putih (Bxf7+): prevCp harus positif
  //    dan < 1490 (menang material tapi belum forced mate). Untuk hitam
  //    (Qxd1+): prevCp dari perspektif hitam = -prevCpWhite, jadi prevCp hitam
  //    = -(-590) = +590. |590| < 1490, tapi -590 (perspektif putih) artinya
  //    hitam sudah sangat menang — ini SUDAH dalam mating attack territory,
  //    bukan "just won material".
  //
  //    Final rule: mating pattern capture valid kalau |prevCpWhiteBefore| < 400.
  //    Ini bedain "recently won material → now creating mate" (Bxf7+: prev=+87)
  //    dari "already deep in winning/mating attack" (Qxd1+: prev=-590, |590|>400).
  const isSettledMate = Math.abs(cpBeforeWhite) >= 1490;
  const isCapture = san.includes("x");

  if (isSettledMate && !isSacrifice) {
    // Exception b: mating pattern capture
    // Butuh prevCpWhiteBefore tersedia dan dalam zona "baru menang material"
    const isMatingPatternCapture =
      isCapture &&
      prevCpWhiteBefore !== null &&
      Math.abs(prevCpWhiteBefore) < 400; // dua move lalu posisi masih "normal winning"

    if (!isMatingPatternCapture) return false;
    // Lolos → lanjut ke only-good-move check di step 4
  }

  // 4) Only-good-move check dari PV pemain aktif sebelum move ini.
  if (pvLinesBeforeWhite.length < 2) return false;

  const pv1cp: any = pvLinesBeforeWhite[0]?.cp ?? null;
  const pv2cp = pvLinesBeforeWhite[1]?.cp ?? null;

  // pv1=null: engine return mate score untuk move terbaik.
  //   - !isSettledMate → genuinely "hanya move ini kasih mate" → brilliant.
  //   - isSettledMate & lolos exception b → brilliant (Bxf7+ dll).
  //   - isSettledMate & tidak lolos → sudah return false di step 3.
  if (pv1cp === null && pv2cp !== null) return true;
  if (pv1cp === null && pv2cp === null) return false; // tidak cukup info

  // pv1=angka & pv2=angka: gap harus signifikan
  const gap = Math.abs(pv1cp - (pv2cp ?? 0));
  void fenBeforeMove;
  return gap > 200;
}

// ── FIX #1 + #2 + #5 + #8: isBrilliantMove ────────────────────────────────────
//
// PERUBAHAN vs versi sebelumnya:
//   - Hapus console.log debug
//   - Logika inti tidak berubah: hanya jalur sacrifice, cpLoss <= 25, gap > 150

export function isBrilliantMove(
  cpLoss: number,
  cpAfterWhite: number,
  pvLinesAfterWhite: PVLine[], // dari evalAfter
  isSacrifice: boolean,
): boolean {
  if (!isSacrifice) return false;
  if (pvLinesAfterWhite.length < 2) return false;
  if (cpLoss > 25) return false;

  void cpAfterWhite; // tersedia untuk logging eksternal kalau dibutuhkan

  const pv1 = pvLinesAfterWhite[0]?.cp ?? 0;
  const pv2 = pvLinesAfterWhite[1]?.cp ?? 0;
  const gap = Math.abs(pv1 - pv2);

  // Sacrifice brilliant: material dilepas, posisi tetap/makin decisive
  return gap > 150;
}

// ── FIX #3b + #8: isGreatMove ────────────────────────────────────────────────
//
// PERUBAHAN:
//   - Tambah parameter cpBeforeWhite untuk detect settled-mate.
//   - FIX #8: path `pv1=null & pv2!=null → true` sebelumnya terlalu agresif.
//     Di posisi forced mate (+M), engine mengembalikan mate score (cp=null)
//     untuk PV terbaik, dan finite cp untuk "slower mate" di PV2 — bukan
//     karena hanya move ini yang kasih mate. Semua check/capture kasual di
//     posisi itu bisa lolos sebagai "great" padahal itu hanya eksekusi.
//
//     Fix: null+angka path hanya lolos kalau posisi BELUM settled
//     (|cpBeforeWhite| < 1490). Kalau sudah settled, tidak ada move yang
//     bisa great hanya dari kondisi PV ini.
//
//   - Aturan null-guard lengkap setelah fix:
//     settled + pv1=null & pv2!=null  → false (eksekusi, bukan great)
//     !settled + pv1=null & pv2!=null → true  (hanya move ini kasih mate)
//     pv1=null & pv2=null             → false (tidak cukup info)
//     pv1=angka & pv2=null            → false (aneh, skip)
//     pv1=angka & pv2=angka           → gap > 200

export function isGreatMove(
  cpLoss: number,
  pvLinesWhite: PVLine[],
  cpBeforeWhite: number = 0, // eval SEBELUM move ini, perspektif putih
): boolean {
  if (cpLoss > 15) return false;
  if (pvLinesWhite.length < 2) return false;

  const isSettledMate = Math.abs(cpBeforeWhite) >= 1490;

  const pv1cp = pvLinesWhite[0]?.cp ?? null;
  const pv2cp = pvLinesWhite[1]?.cp ?? null;

  if (pv1cp === null && pv2cp !== null) {
    // Hanya great kalau posisi BELUM settled — genuinely "hanya move ini kasih mate"
    return !isSettledMate;
  }
  if (pv1cp === null || pv2cp === null) return false; // tidak cukup info

  return Math.abs(pv1cp - pv2cp) > 200;
}

// ── FIX #4: calcAccuracy — dipindah sini, harmonic mean ──────────────────────
//
// PERUBAHAN: harmonic mean alih-alih simple average.
// Harmonic mean lebih sensitif terhadap outlier rendah (blunder),
// sehingga satu blunder menarik accuracy kebawah lebih realistis.
//
// PENTING: hapus calcAccuracy di chessAnalyzer.ts, dan tambah import ini.

export function calcAccuracy(
  analyses: MoveAnalysis[],
  color: "white" | "black",
): number {
  const moves = analyses.filter((m) => {
    const isWhite = m.moveIdx % 2 === 0;
    return color === "white" ? isWhite : !isWhite;
  });

  if (moves.length === 0) return 100;

  let sumReciprocal = 0;
  for (const m of moves) {
    const wBefore = cpToWinPct(m.cpBefore);
    const wAfter = cpToWinPct(m.cpAfter);
    // FIX Bug 4: floor naik dari 1 ke 10.
    // Harmonic mean sangat sensitif terhadap nilai kecil: acc=1 memberi
    // reciprocal 1.0, sedangkan acc=10 memberi reciprocal 0.1. Perbedaan
    // ini dramatis ketika dirata-rata dengan move lain yang acc-nya 95-100
    // (reciprocal 0.01). Floor 1 membuat 1 blunder bisa mendominasi
    // seluruh sum dan menghasilkan accuracy 5-10% meski 90% langkah sempurna.
    // Floor 10 tetap menghukum blunder dengan signifikan tapi proporsional.
    const acc = Math.max(10, winPctToAccuracy(wBefore, wAfter));
    sumReciprocal += 1 / acc;
  }

  const harmonic = moves.length / sumReciprocal;
  return Math.round(harmonic * 10) / 10;
}

// ── Deteksi opening ───────────────────────────────────────────────────────────

export const OPENING_MAP: [string, string, string][] = [
  // Ruy Lopez variations
  [
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3",
    "C92",
    "Ruy López: Closed, Flohr-Zaitsev",
  ],
  [
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O",
    "C84",
    "Ruy López: Closed",
  ],
  ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6", "C78", "Ruy López: Morphy Defense"],
  ["e4 e5 Nf3 Nc6 Bb5 a6", "C65", "Ruy López: Berlin Defense"],
  ["e4 e5 Nf3 Nc6 Bb5", "C60", "Ruy López"],
  // Italian
  ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4", "C54", "Italian: Giuoco Piano"],
  ["e4 e5 Nf3 Nc6 Bc4 Nf6", "C50", "Italian: Two Knights Defense"],
  ["e4 e5 Nf3 Nc6 Bc4", "C50", "Italian Game"],
  // Scotch
  ["e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6", "C45", "Scotch: Schmidt Variation"],
  ["e4 e5 Nf3 Nc6 d4", "C44", "Scotch Game"],
  // Sicilian variations
  ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "B90", "Sicilian: Najdorf"],
  ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6", "B70", "Sicilian: Dragon"],
  ["e4 c5 Nf3 Nc6 Bb5", "B30", "Sicilian: Rossolimo"],
  ["e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 d6", "B43", "Sicilian: Kan"],
  ["e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6", "B35", "Sicilian: Accelerated Dragon"],
  ["e4 c5 Nf3 Nc6 d4 cxd4 Nxd4", "B40", "Sicilian: Open"],
  ["e4 c5", "B20", "Sicilian Defense"],
  // French
  ["e4 e6 d4 d5 Nc3 Nf6 Bg5", "C15", "French: Classical"],
  ["e4 e6 d4 d5 e5", "C02", "French: Advance"],
  ["e4 e6 d4 d5 Nd2", "C10", "French: Tarrasch"],
  ["e4 e6", "C00", "French Defense"],
  // Caro-Kann
  ["e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6", "B13", "Caro-Kann: Classical"],
  ["e4 c6 d4 d5 e5", "B12", "Caro-Kann: Advance"],
  ["e4 c6", "B10", "Caro-Kann Defense"],
  // Pirc / Modern
  ["e4 d6 d4 Nf6 Nc3 g6", "B07", "Pirc Defense"],
  ["e4 g6 d4 d6", "B06", "Modern Defense"],
  // Queen's Gambit
  ["d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6", "D37", "QGD: Classical"],
  ["d4 d5 c4 e6 Nc3 Nf6 Bg5", "D30", "Queen's Gambit Declined"],
  ["d4 d5 c4 dxc4", "D20", "Queen's Gambit Accepted"],
  ["d4 d5 c4 c6 Nf3 Nf6 Nc3 e6", "D45", "Semi-Slav Defense"],
  ["d4 d5 c4 c6", "D10", "Slav Defense"],
  ["d4 d5 c4", "D06", "Queen's Gambit"],
  // King's Indian
  [
    "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5",
    "E91",
    "King's Indian: Classical",
  ],
  ["d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f4", "E86", "King's Indian: Samisch"],
  ["d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3", "E60", "King's Indian Defense"],
  ["d4 Nf6 c4 g6", "E60", "King's Indian Defense"],
  // Nimzo / QID / Catalan
  ["d4 Nf6 c4 e6 Nc3 Bb4", "E20", "Nimzo-Indian Defense"],
  ["d4 Nf6 c4 e6 Nf3 b6", "E10", "Queen's Indian Defense"],
  ["d4 Nf6 c4 e6 Nf3 d5 g3", "E00", "Catalan Opening"],
  // Benoni / Dutch
  ["d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6", "A70", "Benoni: Classical"],
  ["d4 Nf6 c4 c5", "A50", "Benoni Defense"],
  ["d4 f5", "A80", "Dutch Defense"],
  // English
  ["c4 e5 Nc3 Nf6 Nf3 Nc6 g3", "A25", "English: Closed"],
  ["c4 c5 Nf3 Nf6 Nc3 d5", "A34", "English: Symmetrical"],
  ["c4 e5", "A20", "English Opening"],
  ["c4", "A10", "English Opening"],
  // Vienna
  ["e4 e5 Nc3 Nf6 f4", "C29", "Vienna: Vienna Gambit"],
  ["e4 e5 Nc3 Bc5", "C26", "Vienna: Bishop's Opening"],
  ["e4 e5 Nc3", "C25", "Vienna Game"],
  // London / Jobava
  ["d4 d5 Bf4 Nf6 e3 e6 Nf3", "D02", "London System"],
  ["d4 d5 Bf4", "D02", "London System"],
  ["d4 Nf6 Nc3 d5 Bf4", "D00", "Jobava London"],
  // Réti / others
  ["Nf3 d5 g3 Nf6 Bg2 c6", "A07", "Réti: King's Indian Attack"],
  ["Nf3 d5 c4", "A09", "Réti Opening"],
  ["Nf3", "A04", "Réti Opening"],
  // Fallback generics (harus di bawah semua yang spesifik)
  ["e4 e5", "C20", "Open Game"],
  ["d4 d5", "D00", "Queen's Pawn Game"],
  ["e4", "B00", "King's Pawn Opening"],
  ["d4", "A40", "Queen's Pawn Opening"],
];

export function detectOpening(moves: string[]): {
  name: string | null;
  eco: string | null;
} {
  const prefix = moves.slice(0, 16).join(" ");

  let bestMatch: [string, string, string] | null = null;
  let bestLength = -1;

  for (const entry of OPENING_MAP) {
    const [pattern] = entry;
    if (prefix.startsWith(pattern)) {
      const patternLength = pattern.split(" ").length;
      if (patternLength > bestLength) {
        bestLength = patternLength;
        bestMatch = entry;
      }
    }
  }

  if (bestMatch) {
    const [, eco, name] = bestMatch;
    return { name, eco };
  }

  if (moves.length > 0) return { name: "Irregular Opening", eco: null };
  return { name: null, eco: null };
}

// ── Tablebase (Lichess Syzygy) ────────────────────────────────────────────────

export async function queryTablebase(fen: string): Promise<{
  dtz: number | null;
  dtm: number | null;
  bestMove: string | null;
  category: string | null;
}> {
  const { pieceCount } = countMaterialFromFen(fen);
  if (pieceCount > TB_PIECE_THRESHOLD) {
    return { dtz: null, dtm: null, bestMove: null, category: null };
  }
  try {
    const url = `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok)
      return { dtz: null, dtm: null, bestMove: null, category: null };
    const data = await res.json();
    return {
      dtz: data.dtz ?? null,
      dtm: data.dtm ?? null,
      bestMove: data.moves?.[0]?.uci ?? null,
      category: data.category ?? null,
    };
  } catch {
    return { dtz: null, dtm: null, bestMove: null, category: null };
  }
}

// ── Worker factories ──────────────────────────────────────────────────────────

export function createReadyWorker(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const w = spawnRecklessWorker();
    let settled = false;

    const initHandler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      if (e.data === "uciok" && !settled) {
        settled = true;
        clearTimeout(tid);
        w.removeEventListener("message", initHandler);
        resolve(w);
      }
    };

    const tid = setTimeout(() => {
      if (!settled) {
        settled = true;
        w.removeEventListener("message", initHandler);
        log.warn("init", "uciok timeout — terminating worker");
        try {
          w.terminate();
        } catch {
          /* noop */
        }
        reject(new Error("uciok timeout"));
      }
    }, WORKER_INIT_TIMEOUT_MS);

    w.addEventListener("message", initHandler);
    w.postMessage("uci");
  });
}

export async function initBatchWorker(): Promise<Worker> {
  const w = await createReadyWorker();
  w.postMessage(`setoption name MultiPV value ${BATCH_MULTI_PV}`);
  w.postMessage("setoption name Hash value 16");
  w.postMessage("setoption name Threads value 1");
  await new Promise((res) => setTimeout(res, 200));
  return w;
}

// ── Handshake helpers ─────────────────────────────────────────────────────────

export function workerNewGame(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;

    const handler = (e: MessageEvent) => {
      if (resolved || typeof e.data !== "string") return;
      if (e.data === "readyok") {
        resolved = true;
        clearTimeout(tid);
        worker.removeEventListener("message", handler);
        resolve();
      }
    };

    const tid = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        worker.removeEventListener("message", handler);
        resolve();
      }
    }, 1500);

    worker.addEventListener("message", handler);
    worker.postMessage("ucinewgame");
    worker.postMessage("isready");
  });
}

export function workerHandshake(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const handler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      if (e.data === "readyok" && !resolved) {
        resolved = true;
        clearTimeout(tid);
        worker.removeEventListener("message", handler);
        resolve();
      }
    };
    const tid = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        worker.removeEventListener("message", handler);
        resolve();
      }
    }, READYOK_TIMEOUT_MS);
    worker.addEventListener("message", handler);
    worker.postMessage("isready");
  });
}

// ── Utilitas ──────────────────────────────────────────────────────────────────

export function splitIntoChunks<T>(
  arr: T[],
  n: number,
): { items: T[]; startIdx: number }[] {
  const size = Math.ceil(arr.length / n);
  return Array.from({ length: n }, (_, i) => ({
    items: arr.slice(i * size, (i + 1) * size),
    startIdx: i * size,
  })).filter((c) => c.items.length > 0);
}

// ── Singleton init ────────────────────────────────────────────────────────────

export function initSingleton(onReady: () => void) {
  if (_singleton.initialized) {
    if (_singleton.isReady) onReady();
    return;
  }
  _singleton.initialized = true;

  log.info(
    "init",
    `Config — depth:${TARGET_DEPTH} multiPV:${MULTI_PV} parallelWorkers:${PARALLEL_WORKERS}`,
  );

  const liveWorker = spawnRecklessWorker();
  _singleton.liveWorker = liveWorker;

  liveWorker.postMessage("uci");
  liveWorker.postMessage(`setoption name MultiPV value ${LIVE_MULTI_PV}`);
  liveWorker.postMessage("setoption name Hash value 128");
  liveWorker.postMessage("setoption name Threads value 1");

  for (let i = 0; i < PARALLEL_WORKERS; i++) {
    _singleton.workerHealth.set(i, { timeoutCount: 0, isZombie: false });
  }

  _singleton.batchWorkersPromise = Promise.all(
    Array.from({ length: PARALLEL_WORKERS }, () =>
      initBatchWorker().catch((err) => {
        log.warn("init", "batch worker gagal:", err);
        return null;
      }),
    ),
  ).then((workers) => {
    const valid = workers.filter((w): w is Worker => w !== null);
    log.info("init", `${valid.length}/${PARALLEL_WORKERS} batch workers ready`);
    return valid;
  });

  liveWorker.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string" && e.data === "uciok") {
      _singleton.isReady = true;
      onReady();
    }
  });
}
