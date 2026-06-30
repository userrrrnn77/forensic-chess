// src/App.tsx
// chessPageUtils di-inline langsung di sini.
// moduleChess, types, chessAnalyzer tetap di-import.

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { Arrow } from "react-chessboard";
import {
  SkipBack,
  ChevronLeft,
  ChevronRight,
  SkipForward,
  RotateCcw,
  Swords,
  Search,
  FileCode2,
  Loader2,
  RefreshCw,
  Zap,
  Target,
  AlertTriangle,
  Activity,
  BookOpen,
  Clock,
  X,
  Database,
} from "lucide-react";

import { analyzeGame } from "./engine/chessAnalyzer";
import { _singleton, queryTablebase } from "./utils/moduleChess";
import type {
  AnalysisData,
  ChessGameRecord,
  MoveAnalysis,
  PositionData,
  RawChessComGame,
  TablebaseResult,
  PVLine,
  MoveGrade,
} from "./types";

// ============================================================================
// INLINE: chessPageUtils
// ============================================================================

function buildPositions(pgn: string): PositionData[] {
  const g = new Chess();
  try {
    g.loadPgn(pgn);
  } catch {
    return [];
  }
  const history = g.history({ verbose: true }) as { san: string }[];
  const positions: PositionData[] = [{ fen: new Chess().fen(), move: null }];
  const walker = new Chess();
  for (const m of history) {
    walker.move(m.san);
    positions.push({ fen: walker.fen(), move: m.san });
  }
  return positions;
}

function mapRawGamesToRecords(rawGames: RawChessComGame[]): ChessGameRecord[] {
  return rawGames.map((game, idx) => ({
    id: game.url || `game-${idx}`,
    white: game.white?.username || "Unknown",
    black: game.black?.username || "Unknown",
    result:
      game.white?.result === "win"
        ? "White wins"
        : game.black?.result === "win"
          ? "Black wins"
          : "Draw",
    date: new Date((game.end_time || 0) * 1000).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
    }),
    timeControl: game.time_class?.toUpperCase() || "RAPID",
    pgn: game.pgn || "",
  }));
}

function isAtStart(positions: PositionData[], currentMoveIdx: number): boolean {
  return positions.length <= 1 || currentMoveIdx <= -1;
}

function isAtEnd(positions: PositionData[], currentMoveIdx: number): boolean {
  return positions.length <= 1 || currentMoveIdx >= positions.length - 2;
}

function fenAtIndex(positions: PositionData[], idx: number): string | null {
  const target = idx === -1 ? positions[0] : positions[idx + 1];
  return target?.fen ?? null;
}

interface MoveResult {
  newFen: string;
  success: true;
}
interface MoveFailure {
  success: false;
}
type TryMoveResult = MoveResult | MoveFailure;

function tryMove(currentFen: string, from: string, to: string): TryMoveResult {
  const game = new Chess(currentFen);
  if (game.isGameOver()) return { success: false };
  try {
    game.move({ from: from as Square, to: to as Square, promotion: "q" });
    return { success: true, newFen: game.fen() };
  } catch {
    return { success: false };
  }
}

function resolveClickedPiece(
  currentFen: string,
  square: string,
): string | null {
  const game = new Chess(currentFen);
  if (game.isGameOver()) return null;
  const piece = game.get(square as Square);
  return piece && piece.color === game.turn() ? square : null;
}

function cpToAdvantagePercent(cp: number | null): number {
  if (cp === null) return 50;
  return Math.max(0, Math.min(100, 50 + cp / 100));
}

function isBestMoveArrowValid(
  boardFen: string,
  bestMove: string | null,
): boolean {
  if (!bestMove) return false;
  try {
    const g = new Chess(boardFen);
    const lm = g.moves({ verbose: true });
    return lm.some(
      (m) => m.from === bestMove.slice(0, 2) && m.to === bestMove.slice(2, 4),
    );
  } catch {
    return false;
  }
}

function buildBestMoveArrows(
  boardFen: string,
  bestMove: string | null,
): Arrow[] {
  if (!isBestMoveArrowValid(boardFen, bestMove)) return [];
  return [
    {
      startSquare: bestMove!.slice(0, 2),
      endSquare: bestMove!.slice(2, 4),
      color: "rgba(0, 255, 204, 0.8)",
    },
  ];
}

function buildHighlightSquares(
  moveFrom: string | null,
): Record<string, React.CSSProperties> {
  if (!moveFrom) return {};
  return { [moveFrom]: { backgroundColor: "rgba(0, 255, 204, 0.4)" } };
}

interface PairedMove {
  no: number;
  wIdx: number;
  bIdx: number | null;
}

function buildPairedMoves(positions: PositionData[]): PairedMove[] {
  if (positions.length <= 1) return [];
  const pairs: PairedMove[] = [];
  for (let i = 1; i < positions.length; i += 2) {
    pairs.push({
      no: Math.ceil(i / 2),
      wIdx: i - 1,
      bIdx: i < positions.length - 1 ? i : null,
    });
  }
  return pairs;
}

function isWhiteToMove(fen: string): boolean {
  try {
    return new Chess(fen).turn() === "w";
  } catch {
    return true;
  }
}

// ── Current-move from/to (buat highlight + badge di papan) ──────────────────

interface CurrentMoveSquares {
  from: string;
  to: string;
}

/**
 * MoveAnalysis.fen adalah FEN SEBELUM move dijalankan, dan move adalah SAN.
 * Replay SAN itu di atas fen-nya buat dapetin {from, to} secara akurat
 * (termasuk castling, en passant, promosi — semua udah dihandle chess.js).
 */
function getCurrentMoveSquares(
  fenBefore: string,
  san: string,
): CurrentMoveSquares | null {
  try {
    const g = new Chess(fenBefore);
    const result = g.move(san);
    if (!result) return null;
    return { from: result.from, to: result.to };
  } catch {
    return null;
  }
}

function buildCurrentMoveHighlight(
  squares: CurrentMoveSquares | null,
  color: string,
): Record<string, React.CSSProperties> {
  if (!squares) return {};
  const style: React.CSSProperties = { backgroundColor: color };
  return { [squares.from]: style, [squares.to]: style };
}

// ── Status akhir game (checkmate / remis) ────────────────────────────────────

export type GameEndKind =
  | "checkmate"
  | "stalemate"
  | "insufficient"
  | "repetition"
  | "fiftyMove"
  | "agreedDraw"
  | "resignation"
  | "timeout"
  | "timeoutVsInsufficient"
  | "abandoned";

export interface GameEndBadge {
  kind: GameEndKind;
  winner: "white" | "black" | null; // null = remis
}

/**
 * Cek hasil akhir game di posisi tertentu.
 * 1) Coba deteksi dari FEN langsung via chess.js (checkmate/stalemate/dll
 *    yang murni dari posisi papan).
 * 2) Kalau FEN-nya ternyata bukan game-over (berarti game berakhir di luar
 *    papan: timeout, resign, agreement) → fallback ke header [Termination]
 *    / [Result] dari PGN.
 * Return null kalau ini bukan posisi terakhir / game belum berakhir.
 */
function getGameEndBadge(
  fen: string,
  isLastPosition: boolean,
  pgn: string,
): GameEndBadge | null {
  if (!isLastPosition) return null;

  try {
    const g = new Chess(fen);
    if (g.isCheckmate()) {
      // Sisi yang TIDAK jalan (g.turn()) adalah yang kena mat.
      const winner = g.turn() === "w" ? "black" : "white";
      return { kind: "checkmate", winner };
    }
    if (g.isStalemate()) return { kind: "stalemate", winner: null };
    if (g.isInsufficientMaterial())
      return { kind: "insufficient", winner: null };
    if (g.isThreefoldRepetition()) return { kind: "repetition", winner: null };
    if (g.isDraw()) return { kind: "fiftyMove", winner: null };
  } catch {
    /* fen invalid, lanjut ke fallback PGN */
  }

  // Fallback: parse header PGN. Cocok buat timeout/resign/agreement —
  // hal-hal yang gak kebaca cuma dari posisi papan.
  return parsePgnTermination(pgn);
}

function parsePgnTermination(pgn: string): GameEndBadge | null {
  if (!pgn) return null;

  let resultTag = "";
  let terminationTag = "";
  try {
    const g = new Chess();
    g.loadPgn(pgn, { strict: false });
    const headers = g.getHeaders();
    resultTag = headers.Result ?? "";
    terminationTag = headers.Termination ?? "";
  } catch {
    // Fallback regex kalau loadPgn gagal (PGN parsial/aneh)
    const resultMatch = pgn.match(/\[Result\s+"([^"]+)"\]/);
    const termMatch = pgn.match(/\[Termination\s+"([^"]+)"\]/);
    resultTag = resultMatch?.[1] ?? "";
    terminationTag = termMatch?.[1] ?? "";
  }

  if (!resultTag && !terminationTag) return null;

  const winner: "white" | "black" | null =
    resultTag === "1-0" ? "white" : resultTag === "0-1" ? "black" : null;

  const t = terminationTag.toLowerCase();

  if (t.includes("checkmate") || t.includes("mat")) {
    return { kind: "checkmate", winner };
  }
  if (t.includes("time") && t.includes("insufficient")) {
    return { kind: "timeoutVsInsufficient", winner: null };
  }
  if (t.includes("time") || t.includes("abandon")) {
    if (t.includes("abandon")) return { kind: "abandoned", winner };
    return { kind: "timeout", winner };
  }
  if (t.includes("resign")) {
    return { kind: "resignation", winner };
  }
  if (t.includes("agree")) {
    return { kind: "agreedDraw", winner: null };
  }
  if (t.includes("repetition")) {
    return { kind: "repetition", winner: null };
  }
  if (t.includes("50") || t.includes("fifty")) {
    return { kind: "fiftyMove", winner: null };
  }
  if (t.includes("insufficient") || t.includes("material")) {
    return { kind: "insufficient", winner: null };
  }
  if (t.includes("stalemate")) {
    return { kind: "stalemate", winner: null };
  }

  // Gak ada Termination tag tapi ada Result decisive → asumsikan checkmate
  // (paling umum kalau PGN-nya minimal/manual-paste tanpa header lengkap).
  if (winner) return { kind: "checkmate", winner };
  if (resultTag === "1/2-1/2") return { kind: "agreedDraw", winner: null };

  return null;
}

function getGameEndDisplay(badge: GameEndBadge): {
  label: string;
  symbol: string;
  bg: string;
  ring: string;
} {
  switch (badge.kind) {
    case "checkmate":
      return { label: "Checkmate", symbol: "♚", bg: "#b33430", ring: "#fff" };
    case "timeout":
      return { label: "Timeout", symbol: "⏱", bg: "#b33430", ring: "#fff" };
    case "timeoutVsInsufficient":
      return {
        label: "Timeout vs Insufficient Material",
        symbol: "½",
        bg: "#7a7a78",
        ring: "#fff",
      };
    case "resignation":
      return { label: "Resignation", symbol: "⚐", bg: "#b33430", ring: "#fff" };
    case "abandoned":
      return { label: "Abandoned", symbol: "⚐", bg: "#b33430", ring: "#fff" };
    case "stalemate":
      return { label: "Stalemate", symbol: "½", bg: "#7a7a78", ring: "#fff" };
    case "insufficient":
      return {
        label: "Insufficient Material",
        symbol: "½",
        bg: "#7a7a78",
        ring: "#fff",
      };
    case "repetition":
      return {
        label: "Threefold Repetition",
        symbol: "½",
        bg: "#7a7a78",
        ring: "#fff",
      };
    case "fiftyMove":
      return { label: "Draw", symbol: "½", bg: "#7a7a78", ring: "#fff" };
    case "agreedDraw":
      return { label: "Draw Agreed", symbol: "½", bg: "#7a7a78", ring: "#fff" };
  }
}

// ============================================================================
// GRADES & UI HELPERS
// ============================================================================

export const GRADES = [
  {
    key: "brilliant",
    label: "Brilliant",
    symbol: "!!",
    color: "text-cyan-400",
    bg: "bg-cyan-400/10 border-cyan-400/20",
    dot: "#22d3ee",
    squareColor: "rgba(34, 211, 238, 0.45)",
  },
  {
    key: "great",
    label: "Great",
    symbol: "!",
    color: "text-blue-400",
    bg: "bg-blue-400/10 border-blue-400/20",
    dot: "#60a5fa",
    squareColor: "rgba(96, 165, 250, 0.45)",
  },
  {
    key: "best",
    label: "Best",
    symbol: "★",
    color: "text-green-400",
    bg: "bg-green-400/10 border-green-400/20",
    dot: "#4ade80",
    squareColor: "rgba(74, 222, 128, 0.4)",
  },
  {
    key: "excellent",
    label: "Excellent",
    symbol: "👍",
    color: "text-green-400",
    bg: "bg-green-400/10 border-green-400/20",
    dot: "#4ade80",
    squareColor: "rgba(74, 222, 128, 0.35)",
  },
  {
    key: "good",
    label: "Good",
    symbol: "✓",
    color: "text-slate-400",
    bg: "bg-white/5 border-white/5",
    dot: "#94a3b8",
    squareColor: "rgba(148, 163, 184, 0.35)",
  },
  {
    key: "inaccuracy",
    label: "Inaccuracy",
    symbol: "?!",
    color: "text-yellow-400",
    bg: "bg-yellow-400/10 border-yellow-400/20",
    dot: "#facc15",
    squareColor: "rgba(250, 204, 21, 0.4)",
  },
  {
    key: "mistake",
    label: "Mistake",
    symbol: "?",
    color: "text-orange-400",
    bg: "bg-orange-400/10 border-orange-400/20",
    dot: "#fb923c",
    squareColor: "rgba(230, 145, 44, 0.45)",
  },
  {
    key: "blunder",
    label: "Blunder",
    symbol: "??",
    color: "text-red-500",
    bg: "bg-red-500/10 border-red-500/20",
    dot: "#ef4444",
    squareColor: "rgba(179, 52, 48, 0.55)",
  },
  {
    key: "forced",
    label: "Forced",
    symbol: "□",
    color: "text-slate-400",
    bg: "bg-white/5 border-white/5",
    dot: "#94a3b8",
    squareColor: "rgba(148, 163, 184, 0.3)",
  },
  {
    key: "miss",
    label: "Miss",
    symbol: "x",
    color: "text-rose-400",
    bg: "bg-rose-400/10 border-rose-400/20",
    dot: "#fb7185",
    squareColor: "rgba(255, 119, 105, 0.45)",
  },
];

export function getGradeDisplay(grade: MoveGrade) {
  return GRADES.find((g) => g.key === grade) || GRADES[4];
}

// ============================================================================
// BOARD OVERLAY: badge grade / status akhir game di pojok kotak
// ============================================================================

/**
 * Konversi algebraic square ("g3") jadi posisi persen {leftPct, topPct}
 * dari pojok KANAN-ATAS kotak tersebut, relatif ke container papan 8x8.
 * Menghormati boardOrientation (flip kalau orientation === "black").
 */
function squareToCornerPercent(
  square: string,
  orientation: "white" | "black",
): { leftPct: number; topPct: number } {
  const file = square.charCodeAt(0) - "a".charCodeAt(0); // 0-7 (a..h)
  const rank = parseInt(square[1], 10) - 1; // 0-7 (1..8)

  // Kolom grid kiri->kanan, baris grid atas->bawah (rank 8 di atas saat white-bottom)
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;

  // Pojok kanan-atas kotak = (col+1) secara horizontal, row secara vertikal
  return {
    leftPct: ((col + 1) / 8) * 100,
    topPct: (row / 8) * 100,
  };
}

/**
 * Badge bundar nempel di pojok kanan-atas sebuah kotak papan, dipakai untuk
 * grade move ("!!", "??", dst) maupun status akhir game (checkmate/remis).
 * Posisinya absolute terhadap container papan (board wrapper harus position:
 * relative & overflow visible supaya badge yang nongol di tepi gak terpotong).
 */
function BoardCornerBadge({
  square,
  orientation,
  bg,
  ring,
  symbol,
  title,
}: {
  square: string;
  orientation: "white" | "black";
  bg: string;
  ring: string;
  symbol: string;
  title: string;
}) {
  const { leftPct, topPct } = squareToCornerPercent(square, orientation);
  return (
    <div
      title={title}
      className="absolute z-20 flex items-center justify-center rounded-full font-bold pointer-events-none select-none"
      style={{
        left: `${leftPct}%`,
        top: `${topPct}%`,
        width: "6.5%",
        aspectRatio: "1 / 1",
        transform: "translate(-50%, -50%)",
        backgroundColor: bg,
        border: `2px solid ${ring}`,
        boxShadow: "0 2px 6px rgba(0,0,0,0.45)",
        color: "#fff",
        fontSize: "min(2.6vw, 15px)",
        lineHeight: 1,
      }}>
      {symbol}
    </div>
  );
}

// ============================================================================
// SMALL UI COMPONENTS (sama persis seperti sebelumnya)
// ============================================================================

function AccuracyRing({
  value,
  color,
  label,
}: {
  value: number;
  color: string;
  label: string;
}) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  const clampedValue = Math.max(0, Math.min(100, value));
  const dash = (clampedValue / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="68" height="68" viewBox="0 0 68 68">
        <circle
          cx="34"
          cy="34"
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="6"
        />
        <circle
          cx="34"
          cy="34"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 34 34)"
          style={{ transition: "stroke-dasharray 1s ease-out" }}
        />
        <text
          x="34"
          y="38"
          textAnchor="middle"
          dominantBaseline="auto"
          fill="white"
          fontSize="12"
          fontWeight="bold"
          fontFamily="monospace">
          {Math.round(clampedValue)}
        </text>
      </svg>
      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">
        {label}
      </span>
    </div>
  );
}

function SectionHeader({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">
      {icon} <span>{label}</span>
    </div>
  );
}

function MultiPVPanel({
  pvLines,
  isWhiteTurn,
}: {
  pvLines: PVLine[];
  isWhiteTurn: boolean;
}) {
  if (!pvLines.length) return null;
  return (
    <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-white/3 border border-white/5">
      <SectionHeader
        icon={<Activity size={12} />}
        label={`Top Lines (MultiPV ${pvLines.length})`}
      />
      <div className="flex flex-col gap-1">
        {pvLines.map((pv, i) => {
          const rawCp = pv.cp ?? 0;
          const whiteAdv = isWhiteTurn ? rawCp : -rawCp;
          const displayCp =
            pv.mate != null
              ? pv.mate > 0
                ? `+M${Math.abs(pv.mate)}`
                : `-M${Math.abs(pv.mate)}`
              : `${whiteAdv >= 0 ? "+" : ""}${(whiteAdv / 100).toFixed(2)}`;
          const cpColor =
            pv.mate != null
              ? pv.mate > 0
                ? "text-cyan-400"
                : "text-purple-400"
              : whiteAdv > 0
                ? "text-cyan-400"
                : whiteAdv < 0
                  ? "text-purple-400"
                  : "text-slate-300";
          return (
            <div
              key={i}
              className="flex items-center gap-2 p-2 rounded-lg bg-white/5 border border-white/5 text-[11px] font-mono">
              <span
                className={`w-5 text-center font-bold ${i === 0 ? "text-cyan-400" : "text-slate-500"}`}>
                {i + 1}.
              </span>
              <span className={`w-12 text-right font-bold ${cpColor}`}>
                {displayCp}
              </span>
              <span className="text-slate-400 truncate flex-1">
                {pv.moves.slice(0, 5).join(" ")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OpeningPanel({
  name,
  eco,
  gamePhases,
}: {
  name: string | null;
  eco: string | null;
  gamePhases: { opening: number; middlegame: number; endgame: number } | null;
}) {
  if (!name) return null;
  const phases = gamePhases
    ? [
        { label: "Opening", val: gamePhases.opening, color: "bg-cyan-400" },
        { label: "Middle", val: gamePhases.middlegame, color: "bg-purple-400" },
        { label: "Endgame", val: gamePhases.endgame, color: "bg-amber-400" },
      ]
    : [];
  return (
    <div className="flex flex-col gap-3 p-3 rounded-xl bg-white/3 border border-white/5">
      <div className="flex items-center gap-2.5">
        <BookOpen size={16} className="text-cyan-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white leading-tight truncate">
            {name}
          </div>
          {eco && (
            <div className="text-[10px] text-slate-500 font-mono mt-0.5">
              {eco}
            </div>
          )}
        </div>
      </div>
      {phases.length > 0 && (
        <div className="flex gap-2">
          {phases.map(({ label, val, color }) => (
            <div
              key={label}
              className="flex-1 flex flex-col items-center gap-1.5">
              <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className={`h-full ${color} rounded-full transition-all duration-700`}
                  style={{ width: `${val}%` }}
                />
              </div>
              <span className="text-[9px] text-slate-500 uppercase font-bold">
                {label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MoveExplanationPanel({ analysis }: { analysis: MoveAnalysis | null }) {
  if (!analysis) return null;
  const g = getGradeDisplay(analysis.grade);
  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-white/3 border border-white/5">
      <div className="flex items-center gap-2">
        <span className={`font-bold text-sm ${g.color}`}>{g.symbol}</span>
        <span className="font-mono text-sm text-white font-bold">
          {analysis.move}
        </span>
        <span className="text-[10px] text-slate-500 ml-auto capitalize">
          {analysis.phase}
        </span>
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        {analysis.explanation}
      </p>
      {analysis.tacticalTheme.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {analysis.tacticalTheme.map((t) => (
            <span
              key={t}
              className="text-[10px] px-2 py-0.5 rounded bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 font-semibold">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TablebasePanel({ result }: { result: TablebaseResult | null }) {
  if (!result || (!result.dtz && !result.category)) return null;
  const catColors: Record<string, string> = {
    win: "text-green-400",
    loss: "text-red-400",
    draw: "text-yellow-400",
  };
  const catColor = catColors[result.category ?? ""] ?? "text-slate-400";
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/3 border border-white/5 mt-2">
      <Database size={16} className="text-amber-400 shrink-0" />
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-[10px] text-slate-500 uppercase tracking-widest">
          Syzygy Tablebase
        </span>
        <div className="flex items-center gap-3 mt-0.5">
          {result.category && (
            <span className={`text-sm font-bold capitalize ${catColor}`}>
              {result.category}
            </span>
          )}
          {result.dtz != null && (
            <span className="text-xs text-slate-400 font-mono">
              DTZ: {result.dtz}
            </span>
          )}
          {result.dtm != null && (
            <span className="text-xs text-slate-400 font-mono">
              DTM: {result.dtm}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AnalysisProgressModal({
  isOpen,
  progress,
  onCancel,
}: {
  isOpen: boolean;
  progress: number;
  onCancel: () => void;
}) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="w-full max-w-sm bg-[#0a0b0e] border border-white/10 p-6 rounded-3xl shadow-2xl flex flex-col gap-4">
        <div className="text-center">
          <h3 className="text-lg font-bold text-white">Reckless WASM Engine</h3>
          <div className="w-16 h-16 mx-auto my-4 bg-white/5 rounded-2xl flex items-center justify-center border border-white/10">
            <Loader2 size={32} className="text-cyan-400 animate-spin" />
          </div>
          <p className="text-cyan-400 font-mono text-xs mt-2">
            {progress}% Completed
          </p>
        </div>
        <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-linear-to-r from-cyan-400 to-purple-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <button
          onClick={onCancel}
          className="mt-2 w-full py-2 bg-red-500/10 text-red-500 font-bold rounded-xl hover:bg-red-500 hover:text-white transition-all text-xs uppercase">
          Batalkan Analisis
        </button>
      </div>
    </div>
  );
}

function RecentGamesModal({
  isOpen,
  onClose,
  username,
  games,
  onSelectGame,
}: {
  isOpen: boolean;
  onClose: () => void;
  username: string;
  games: ChessGameRecord[];
  onSelectGame: (pgn: string, white: string, black: string) => void;
}) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="w-full max-w-2xl max-h-[80vh] bg-[#0a0b0e]/95 border border-white/10 rounded-3xl shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-start justify-between p-6 border-b border-white/5">
          <div>
            <h2 className="text-lg font-bold text-white">
              Riwayat Pertandingan
            </h2>
            <div className="text-xs text-slate-500 mt-1">
              <span className="text-cyan-400 font-semibold">{username}</span> •{" "}
              {games.length} games ditemukan
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-white/10 text-slate-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {games.length === 0 ? (
            <p className="text-center text-slate-500 py-10">
              Data tidak ditemukan.
            </p>
          ) : (
            games.map((game, i) => {
              const isWhite =
                game.white.toLowerCase() === username.toLowerCase();
              const isWin = game.result.includes(isWhite ? "White" : "Black");
              return (
                <div
                  key={i}
                  onClick={() => onSelectGame(game.pgn, game.white, game.black)}
                  className="flex items-center justify-between p-4 rounded-xl bg-white/3 border border-white/5 hover:bg-white/10 hover:border-cyan-400/30 transition-all cursor-pointer">
                  <div className="flex flex-col gap-2">
                    <div className="text-sm font-medium text-white/80">
                      <span
                        className={isWhite ? "text-cyan-400 font-bold" : ""}>
                        {game.white}
                      </span>
                      <span className="text-slate-500 mx-2 text-xs">vs</span>
                      <span
                        className={!isWhite ? "text-cyan-400 font-bold" : ""}>
                        {game.black}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-slate-500">
                      <span className="flex items-center gap-1.5">
                        <Clock size={12} /> {game.date}
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-white/10 text-white/70 font-bold tracking-widest">
                        {game.timeControl}
                      </span>
                    </div>
                  </div>
                  <div
                    className={`text-xs font-bold ${isWin ? "text-emerald-400" : "text-rose-500"}`}>
                    {game.result}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// LIVE EVAL STATE  (replaces useStockfish — minimal live eval via singleton worker)
// ============================================================================

interface LiveEval {
  cp: number | null;
  mate: number | null;
  bestMove: string | null;
  depth: number;
  nps: number;
  pvLines: PVLine[];
}

const EMPTY_EVAL: LiveEval = {
  cp: null,
  mate: null,
  bestMove: null,
  depth: 0,
  nps: 0,
  pvLines: [],
};

import { FaGithub } from "react-icons/fa";

const GITHUB_URL = "https://github.com/userrrrnn77/forensic-chess";

function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:h-16 sm:px-6">
        {/* Kiri: wordmark */}
        <a
          href="/"
          className="flex items-center gap-2 font-mono text-sm font-semibold tracking-tight text-zinc-100 sm:text-base">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          <span>
            Forensic<span className="text-emerald-500">Chess</span>
          </span>
        </a>

        {/* Kanan: GitHub */}
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View source on GitHub"
          className="flex items-center justify-center rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500">
          <FaGithub className="h-5 w-5 sm:h-5.5 sm:w-5.5" />
        </a>
      </nav>
    </header>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function App() {
  const [activeTab, setActiveTab] = useState<"pgn" | "chesscom" | "lichess">(
    "pgn",
  );
  const [pgnInput, setPgnInput] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);

  const [positions, setPositions] = useState<PositionData[]>([]);
  const [currentMoveIdx, setCurrentMoveIdx] = useState(-1);
  const [boardPos, setBoardPos] = useState(new Chess().fen());

  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [fetchedGames, setFetchedGames] = useState<ChessGameRecord[]>([]);
  const [moveFrom, setMoveFrom] = useState<string | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">(
    "white",
  );
  const [players, setPlayers] = useState({
    white: "White Player",
    black: "Black Player",
  });

  // Analysis progress state (replaces isBatchAnalyzing / batchProgress)
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const cancelRef = useRef(false);

  const [tablebaseResult, setTablebaseResult] =
    useState<TablebaseResult | null>(null);
  const [activePanel, setActivePanel] = useState<
    "analysis" | "moves" | "position"
  >("analysis");

  // Live eval from singleton worker (from moduleChess _singleton.liveWorker)
  const [liveEval, setLiveEval] = useState<LiveEval>(EMPTY_EVAL);
  const [isLiveAnalyzing, setIsLiveAnalyzing] = useState(false);
  const liveEvalAbortRef = useRef<(() => void) | null>(null);

  const moveListRef = useRef<HTMLDivElement>(null);

  // ── Live eval a FEN via liveWorker ────────────────────────────────────────
  const analyzePositionLive = useCallback((fen: string) => {
    const w = _singleton.liveWorker;
    if (!w) return;

    // Cancel previous
    if (liveEvalAbortRef.current) {
      liveEvalAbortRef.current();
    }

    setIsLiveAnalyzing(true);
    let settled = false;
    const pvMap = new Map<number, PVLine>();

    const handler = (e: MessageEvent) => {
      if (settled || typeof e.data !== "string") return;
      const msg = e.data.trim();

      if (msg.startsWith("info depth")) {
        const depthM = msg.match(/\bdepth (\d+)/);
        const mpvM = msg.match(/\bmultipv (\d+)/);
        const cpM = msg.match(/\bscore cp (-?\d+)/);
        const mateM = msg.match(/\bscore mate (-?\d+)/);
        const npsM = msg.match(/\bnps (\d+)/);
        const pvM = msg.match(/\bpv (.+)$/);
        if (!depthM) return;
        const depth = parseInt(depthM[1], 10);
        const mpv = mpvM ? parseInt(mpvM[1], 10) : 1;
        const cp = cpM ? parseInt(cpM[1], 10) : null;
        const mate = mateM ? parseInt(mateM[1], 10) : null;
        const nps = npsM ? parseInt(npsM[1], 10) : 0;
        const moves = pvM ? pvM[1].trim().split(/\s+/) : [];
        const existing = pvMap.get(mpv);
        if (!existing || depth >= existing.depth)
          pvMap.set(mpv, { depth, cp, mate, moves });

        const bestPv = pvMap.get(1);
        setLiveEval({
          cp: bestPv?.cp ?? null,
          mate: bestPv?.mate ?? null,
          bestMove: bestPv?.moves[0] ?? null,
          depth,
          nps,
          pvLines: Array.from(pvMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, v]) => v),
        });
        return;
      }

      if (msg.startsWith("bestmove")) {
        settled = true;
        w.removeEventListener("message", handler);
        setIsLiveAnalyzing(false);
      }
    };

    const abort = () => {
      settled = true;
      w.removeEventListener("message", handler);
      w.postMessage("stop");
      setIsLiveAnalyzing(false);
    };

    liveEvalAbortRef.current = abort;
    w.addEventListener("message", handler);
    w.postMessage("ucinewgame");
    w.postMessage(`position fen ${fen}`);
    w.postMessage("go depth 20 multipv 3");
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const currentMoveAnalysis = useMemo((): MoveAnalysis | null => {
    if (!analysisData || currentMoveIdx < 0) return null;
    return analysisData.moveAnalyses[currentMoveIdx] ?? null;
  }, [analysisData, currentMoveIdx]);

  const rawAdvantage = cpToAdvantagePercent(liveEval.cp ?? 0);
  const isWhiteTurn = useMemo(() => isWhiteToMove(boardPos), [boardPos]);
  const pairedMoves = useMemo(() => buildPairedMoves(positions), [positions]);
  const atStart = isAtStart(positions, currentMoveIdx);
  const atEnd = isAtEnd(positions, currentMoveIdx);

  // from/to square dari move yang sedang diliat (buat highlight + badge grade)
  const currentMoveSquares = useMemo(() => {
    if (!currentMoveAnalysis) return null;
    return getCurrentMoveSquares(
      currentMoveAnalysis.fen,
      currentMoveAnalysis.move,
    );
  }, [currentMoveAnalysis]);

  const gradeDisplay = currentMoveAnalysis
    ? getGradeDisplay(currentMoveAnalysis.grade)
    : null;

  const gradeHighlightSquares = useMemo(
    () =>
      buildCurrentMoveHighlight(
        currentMoveSquares,
        gradeDisplay?.squareColor ?? "rgba(0, 255, 204, 0.4)",
      ),
    [currentMoveSquares, gradeDisplay],
  );

  // Klik manual (pilih piece) overrides highlight grade di square asalnya
  const clickHighlightSquares = buildHighlightSquares(moveFrom);
  const highlightSquares = useMemo(
    () => ({ ...gradeHighlightSquares, ...clickHighlightSquares }),
    [gradeHighlightSquares, clickHighlightSquares],
  );

  const bestMoveArrowObj = useMemo(
    () => buildBestMoveArrows(boardPos, liveEval.bestMove),
    [boardPos, liveEval.bestMove],
  );

  // Badge checkmate/remis: cuma muncul kalau lagi liat posisi TERAKHIR game
  const gameEndBadge = useMemo(() => {
    if (positions.length <= 1) return null;
    const isLastPosition = currentMoveIdx === positions.length - 2;
    return getGameEndBadge(boardPos, isLastPosition, pgnInput);
  }, [boardPos, positions, currentMoveIdx, pgnInput]);

  const gameEndKingSquare = useMemo(() => {
    if (!gameEndBadge || gameEndBadge.kind !== "checkmate") return null;
    try {
      const g = new Chess(boardPos);
      const loserColor = g.turn(); // sisi yang lagi giliran = sisi yang di-mat
      const board = g.board();
      for (const row of board) {
        for (const cell of row) {
          if (cell && cell.type === "k" && cell.color === loserColor) {
            return cell.square;
          }
        }
      }
    } catch {
      /* noop */
    }
    return null;
  }, [boardPos, gameEndBadge]);

  const distW = analysisData?.moveDistribution.white ?? {};
  const distB = analysisData?.moveDistribution.black ?? {};

  // ── Navigation ────────────────────────────────────────────────────────────
  const goToMove = useCallback(
    (idx: number) => {
      const fen = fenAtIndex(positions, idx);
      if (!fen) return;
      setBoardPos(fen);
      setCurrentMoveIdx(idx);
      setMoveFrom(null);
      setTablebaseResult(null);
      analyzePositionLive(fen);
      queryTablebase(fen).then((res) => {
        if (res.category || res.dtz) setTablebaseResult(res);
      });
    },
    [positions, analyzePositionLive],
  );

  const handlePrev = useCallback(
    () => goToMove(Math.max(-1, currentMoveIdx - 1)),
    [currentMoveIdx, goToMove],
  );
  const handleNext = useCallback(() => {
    if (!atEnd) goToMove(currentMoveIdx + 1);
  }, [atEnd, currentMoveIdx, goToMove]);
  const handleFirst = useCallback(() => {
    if (!positions.length) return;
    setBoardPos(positions[0].fen);
    setCurrentMoveIdx(-1);
    setMoveFrom(null);
    if (liveEvalAbortRef.current) liveEvalAbortRef.current();
    setTablebaseResult(null);
  }, [positions]);
  const handleLast = useCallback(() => {
    if (positions.length) goToMove(positions.length - 2);
  }, [positions, goToMove]);

  const handleReset = useCallback(() => {
    setBoardPos(new Chess().fen());
    setCurrentMoveIdx(-1);
    setPositions([]);
    setPgnInput("");
    setMoveFrom(null);
    if (liveEvalAbortRef.current) liveEvalAbortRef.current();
    setAnalysisData(null);
    setTablebaseResult(null);
    setLiveEval(EMPTY_EVAL);
  }, []);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") handlePrev();
      if (e.key === "ArrowRight") handleNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handlePrev, handleNext]);

  // Auto-scroll move list
  useEffect(() => {
    if (!moveListRef.current || currentMoveIdx < 0) return;
    const row = moveListRef.current.querySelector(
      `[data-idx="${currentMoveIdx}"]`,
    ) as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentMoveIdx]);

  // ── Start analysis (replaces startAnalysis + runFullAnalysis) ─────────────
  const startAnalysis = useCallback(
    async (pgn: string, whiteName?: string, blackName?: string) => {
      const pos = buildPositions(pgn);
      if (pos.length === 0) {
        alert("PGN Tidak Valid, Bre!");
        return;
      }

      setPositions(pos);
      setCurrentMoveIdx(-1);
      setBoardPos(pos[0].fen);
      setAnalysisData(null);
      setTablebaseResult(null);
      setIsAnalyzing(true);
      setAnalysisProgress(0);
      cancelRef.current = false;
      if (whiteName)
        setPlayers({ white: whiteName, black: blackName ?? "Black Player" });

      try {
        const result = await analyzeGame(pgn, {
          onProgress: (p) => {
            if (cancelRef.current) return;
            setAnalysisProgress(Math.round(p * 100));
          },
        });

        if (cancelRef.current) return;

        setAnalysisData(result);
        setAnalysisProgress(100);

        // Jump to last move
        if (pos.length > 1) {
          const lastIdx = pos.length - 2;
          const lastFen = pos[pos.length - 1].fen;
          setBoardPos(lastFen);
          setCurrentMoveIdx(lastIdx);
          analyzePositionLive(lastFen);
        }
      } catch (err) {
        console.error("analyzeGame error:", err);
        alert("Analisis gagal, Bre. Cek console.");
      } finally {
        setIsAnalyzing(false);
      }
    },
    [analyzePositionLive],
  );

  const handleCancelAnalysis = useCallback(() => {
    cancelRef.current = true;
    setIsAnalyzing(false);
    setAnalysisProgress(0);
  }, []);

  // ── Load PGN ──────────────────────────────────────────────────────────────
  const handleLoadPgn = () => {
    if (pgnInput.trim()) startAnalysis(pgnInput);
  };

  // ── Chess.com fetch ───────────────────────────────────────────────────────
  const handleSearchChessCom = async () => {
    if (!usernameInput.trim()) return;
    setIsLoading(true);
    try {
      const archivesRes = await fetch(
        `https://api.chess.com/pub/player/${usernameInput}/games/archives`,
      );
      if (!archivesRes.ok) {
        throw new Error("User not found");
      }
      const { archives } = await archivesRes.json();
      if (!archives || archives.length === 0) {
        alert("User ini belum punya game tercatat, Bre.");
        setIsLoading(false);
        return;
      }
      // archives urutannya dari lama -> baru, jadi tinggal ambil index terakhir
      const latestArchiveUrl = archives[archives.length - 1];
      const res = await fetch(latestArchiveUrl);
      const data = await res.json();
      const games: RawChessComGame[] = (data.games ?? []).slice(-10).reverse();
      setFetchedGames(mapRawGamesToRecords(games));
      setIsModalOpen(true);
    } catch (e) {
      alert("Gagal ambil data Chess.com, Bre. Username bener gak?");
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Lichess fetch ─────────────────────────────────────────────────────────
  const handleSearchLichess = async () => {
    if (!usernameInput.trim()) return;
    setIsLoading(true);
    try {
      const res = await fetch(
        `https://lichess.org/api/games/user/${usernameInput}?max=10&pgnInJson=true`,
        { headers: { Accept: "application/x-ndjson" } },
      );
      const text = await res.text();
      const games = text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const mapped: ChessGameRecord[] = games.map((g: any, idx: number) => ({
        id: g.id || `lichess-${idx}`,
        white: g.players?.white?.user?.name || "Unknown",
        black: g.players?.black?.user?.name || "Unknown",
        result:
          g.winner === "white"
            ? "White wins"
            : g.winner === "black"
              ? "Black wins"
              : "Draw",
        date: new Date(g.createdAt || Date.now()).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
        }),
        timeControl: g.clock
          ? `${g.clock.initial / 60}+${g.clock.increment}`
          : "Correspondence",
        pgn: g.pgn || "",
      }));
      setFetchedGames(mapped);
      setIsModalOpen(true);
    } catch (e) {
      alert("Gagal narik data dari Lichess, Bre! Cek username lu.");
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectGameFromModal = (
    pgn: string,
    white: string,
    black: string,
  ) => {
    setIsModalOpen(false);
    setPgnInput(pgn);
    setActiveTab("pgn");
    startAnalysis(pgn, white, black);
  };

  // ── Board interaction ─────────────────────────────────────────────────────
  const handleSquareClick = ({ square }: { square: string }) => {
    if (!moveFrom) {
      setMoveFrom(resolveClickedPiece(boardPos, square));
      return;
    }
    if (moveFrom === square) {
      setMoveFrom(null);
      return;
    }
    const result = tryMove(boardPos, moveFrom, square);
    if (result.success) {
      setBoardPos(result.newFen);
      setMoveFrom(null);
      analyzePositionLive(result.newFen);
    } else {
      setMoveFrom(resolveClickedPiece(boardPos, square));
    }
  };

  const handlePieceDrop = ({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    if (!targetSquare) return false;
    const result = tryMove(boardPos, sourceSquare, targetSquare);
    if (result.success) {
      setBoardPos(result.newFen);
      setMoveFrom(null);
      analyzePositionLive(result.newFen);
      return true;
    }
    return false;
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="min-h-screen w-full bg-[#050505] text-slate-200 relative overflow-x-hidden">
      {/* Glow / Cyberpunk effects */}
      <Navbar />
      <div className="flex items-center justify-center flex-col gap-6 p-4 lg:p-8 pt-6 lg:pt-8">
        <div className="absolute top-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-cyan-400/5 blur-[120px] pointer-events-none" />
        <div className="fixed bottom-0 left-0 w-31.25 h-31.25 rounded-full bg-purple-500 blur-[120px] pointer-events-none -z-10" />

        <div className="mx-auto w-full max-w-7xl grid grid-cols-1 xl:grid-cols-[720px_380px] items-start justify-center gap-7 xl:gap-14">
          {/* ── KIRI: Papan ─────────────────────────────────────────────────── */}
          <div className="flex flex-col items-center gap-4 z-10 w-full">
            {/* Black player info */}
            <div className="w-full max-w-2xl flex items-center justify-between px-2 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center font-bold text-sm">
                  B
                </div>
                <div>
                  <div className="font-bold text-sm tracking-wide">
                    {boardOrientation === "white"
                      ? players.black
                      : players.white}
                  </div>
                  {analysisData && (
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      Akurasi:{" "}
                      <span className="text-purple-400 font-mono">
                        {boardOrientation === "white"
                          ? analysisData.accuracyByColor.black
                          : analysisData.accuracyByColor.white}
                        %
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Board */}
            <div className="w-full max-w-150 aspect-square bg-[#0a0b0e] rounded-xl border border-white/10 shadow-[0_0_40px_rgba(0,0,0,0.4)] overflow-visible relative shrink-0">
              <div className="w-full h-full rounded-xl overflow-hidden">
                <Chessboard
                  options={{
                    id: "main-board",
                    position: boardPos,
                    boardOrientation: boardOrientation,
                    darkSquareStyle: { backgroundColor: "#69923e" },
                    lightSquareStyle: { backgroundColor: "#fff" },
                    squareStyles: highlightSquares,
                    arrows: bestMoveArrowObj,
                    animationDurationInMs: 350,
                    showAnimations: true,
                    allowDragging: true,
                    onSquareClick: handleSquareClick,
                    onPieceDrop: handlePieceDrop,
                  }}
                />
              </div>

              {/* Overlay: badge grade move (current) + badge checkmate/remis */}
              {currentMoveSquares && gradeDisplay && currentMoveAnalysis && (
                <BoardCornerBadge
                  square={currentMoveSquares.to}
                  orientation={boardOrientation}
                  bg={gradeDisplay.dot}
                  ring="#ffffff"
                  symbol={gradeDisplay.symbol}
                  title={`${gradeDisplay.label}: ${currentMoveAnalysis.move}`}
                />
              )}
              {gameEndBadge &&
                (() => {
                  const display = getGameEndDisplay(gameEndBadge);
                  const anchorSquare =
                    gameEndBadge.kind === "checkmate" && gameEndKingSquare
                      ? gameEndKingSquare
                      : (currentMoveSquares?.to ?? "h1");
                  return (
                    <BoardCornerBadge
                      square={anchorSquare}
                      orientation={boardOrientation}
                      bg={display.bg}
                      ring={display.ring}
                      symbol={display.symbol}
                      title={display.label}
                    />
                  );
                })()}
            </div>

            {/* White player info */}
            <div className="w-full max-w-2xl flex items-center justify-between px-2 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-cyan-400/10 border border-cyan-400/30 flex items-center justify-center font-bold text-cyan-400 text-sm">
                  W
                </div>
                <div>
                  <div className="font-bold text-sm tracking-wide text-cyan-400">
                    {boardOrientation === "white"
                      ? players.white
                      : players.black}
                  </div>
                  {analysisData && (
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      Akurasi:{" "}
                      <span className="text-cyan-400 font-mono">
                        {boardOrientation === "white"
                          ? analysisData.accuracyByColor.white
                          : analysisData.accuracyByColor.black}
                        %
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Nav controls */}
            <div className="w-full max-w-150 flex flex-wrap items-center justify-center gap-2 mt-1 bg-white/5 p-2 rounded-2xl backdrop-blur-md border border-white/5 shrink-0">
              <button
                onClick={handleFirst}
                disabled={atStart}
                className="p-3 rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed text-slate-500 hover:text-white hover:bg-white/10">
                <SkipBack size={18} />
              </button>
              <button
                onClick={handlePrev}
                disabled={atStart}
                className="p-3 rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed text-slate-500 hover:text-white hover:bg-white/10">
                <ChevronLeft size={22} />
              </button>
              <button
                onClick={handleReset}
                className="p-2.5 px-8 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold transition-all border border-white/5">
                <RotateCcw size={16} />
              </button>
              <button
                onClick={handleNext}
                disabled={atEnd}
                className="p-3 rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed text-slate-500 hover:text-white hover:bg-white/10">
                <ChevronRight size={22} />
              </button>
              <button
                onClick={handleLast}
                disabled={atEnd}
                className="p-3 rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed text-slate-500 hover:text-white hover:bg-white/10">
                <SkipForward size={18} />
              </button>
              <button
                onClick={() =>
                  setBoardOrientation((o) =>
                    o === "white" ? "black" : "white",
                  )
                }
                className="p-3 rounded-xl transition-all text-slate-500 hover:text-white hover:bg-white/10">
                <RefreshCw size={18} />
              </button>
            </div>

            <TablebasePanel result={tablebaseResult} />
          </div>

          {/* ── KANAN: Dashboard ────────────────────────────────────────────── */}
          <div className="w-full max-w-100 xl:max-w-none h-200 flex flex-col z-10">
            <div className="bg-[#0a0b0e]/90 backdrop-blur-3xl rounded-3xl border border-white/10 flex flex-col overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.6)] h-full">
              {/* Panel tabs */}
              <div className="flex border-b border-white/10 bg-white/5 shrink-0">
                {[
                  {
                    key: "analysis",
                    label: "Analisis",
                    icon: <Swords size={13} />,
                  },
                  {
                    key: "moves",
                    label: "Langkah",
                    icon: <FileCode2 size={13} />,
                  },
                  {
                    key: "position",
                    label: "Posisi",
                    icon: <Target size={13} />,
                  },
                ].map(({ key, label, icon }) => (
                  <button
                    key={key}
                    onClick={() => setActivePanel(key as typeof activePanel)}
                    className={`flex-1 py-3.5 text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-1.5 transition-all border-b-2 ${
                      activePanel === key
                        ? "border-cyan-400 text-cyan-400 bg-cyan-400/5"
                        : "border-transparent text-slate-500 hover:text-slate-300"
                    }`}>
                    {icon} {label}
                  </button>
                ))}
              </div>

              <div className="overflow-y-auto p-4 flex flex-col gap-4 flex-1">
                {/* Source input form */}
                <div className="flex flex-col gap-3 bg-white/5 p-4 rounded-2xl border border-white/10 shrink-0">
                  <div className="flex bg-[#050505] p-1 rounded-xl border border-white/5">
                    {[
                      {
                        key: "pgn",
                        label: "PGN",
                        icon: <FileCode2 size={12} />,
                        active: "bg-white/10 text-cyan-400",
                      },
                      {
                        key: "chesscom",
                        label: "Chess.com",
                        icon: <Search size={12} />,
                        active: "bg-white/10 text-green-400",
                      },
                      {
                        key: "lichess",
                        label: "Lichess",
                        icon: <Search size={12} />,
                        active: "bg-white/10 text-purple-400",
                      },
                    ].map(({ key, label, icon, active }) => (
                      <button
                        key={key}
                        onClick={() => setActiveTab(key as any)}
                        className={`flex-1 py-2 text-[10px] font-bold uppercase rounded-lg transition-all flex items-center justify-center gap-1.5 ${activeTab === key ? active : "text-slate-500"}`}>
                        {icon} {label}
                      </button>
                    ))}
                  </div>

                  {activeTab === "pgn" ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={pgnInput}
                        onChange={(e) => setPgnInput(e.target.value)}
                        placeholder="1. e4 e5 2. Nf3..."
                        className="w-full h-20 bg-[#050505] border border-white/10 rounded-xl p-3 text-xs text-white font-mono focus:border-cyan-400/50 resize-none outline-none"
                      />
                      <button
                        onClick={handleLoadPgn}
                        disabled={!pgnInput || isAnalyzing}
                        className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all bg-cyan-400/10 text-cyan-400 border border-cyan-400/30 hover:bg-cyan-400 hover:text-black disabled:opacity-50">
                        {isAnalyzing
                          ? `Analyzing... ${analysisProgress}%`
                          : "Bedah TKP!"}
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="relative">
                        <Search
                          size={14}
                          className="absolute left-3 top-2.5 text-slate-500"
                        />
                        <input
                          type="text"
                          value={usernameInput}
                          onChange={(e) => setUsernameInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              activeTab === "chesscom"
                                ? handleSearchChessCom()
                                : handleSearchLichess();
                            }
                          }}
                          placeholder={`Username ${activeTab === "chesscom" ? "Chess.com" : "Lichess"}...`}
                          className="w-full bg-[#050505] border border-white/10 rounded-xl py-2.5 pl-9 pr-4 text-xs text-white focus:border-cyan-400/50 outline-none"
                        />
                      </div>
                      <button
                        onClick={
                          activeTab === "chesscom"
                            ? handleSearchChessCom
                            : handleSearchLichess
                        }
                        disabled={isLoading || !usernameInput}
                        className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 bg-purple-500/10 text-purple-400 border border-purple-500/30 hover:bg-purple-500 hover:text-white disabled:opacity-50">
                        {isLoading ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          "Tarik Data"
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Analysis panel ───────────────────────────────────────── */}
                {activePanel === "analysis" && (
                  <>
                    <OpeningPanel
                      name={analysisData?.openingName ?? null}
                      eco={analysisData?.openingEco ?? null}
                      gamePhases={analysisData?.gamePhases ?? null}
                    />

                    {positions.length > 0 && (
                      <div className="flex flex-col gap-3 p-4 rounded-2xl bg-white/5 border border-white/10 shrink-0">
                        <div className="flex justify-between items-center border-b border-white/5 pb-2">
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                            Live Evaluation
                          </span>
                          <div className="flex items-center gap-2">
                            {isLiveAnalyzing && (
                              <Loader2
                                size={10}
                                className="text-cyan-400 animate-spin"
                              />
                            )}
                            <span className="text-[10px] text-cyan-400 font-mono bg-cyan-400/10 px-2 py-0.5 rounded border border-cyan-400/20">
                              d{liveEval.depth} ·{" "}
                              {(liveEval.nps / 1000).toFixed(0)}kn/s
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <AccuracyRing
                            value={
                              liveEval.mate
                                ? liveEval.mate > 0
                                  ? 100
                                  : 0
                                : rawAdvantage
                            }
                            color="#22d3ee"
                            label="W-Adv"
                          />
                          <div className="flex flex-col items-center justify-center flex-1">
                            <div className="text-3xl font-black font-mono tracking-tighter">
                              {isLiveAnalyzing &&
                              !liveEval.cp &&
                              !liveEval.mate ? (
                                <span className="text-slate-500 animate-pulse text-xl">
                                  Calc...
                                </span>
                              ) : liveEval.mate ? (
                                <span className="text-rose-400">
                                  M{Math.abs(liveEval.mate)}
                                </span>
                              ) : (
                                <span
                                  className={
                                    liveEval.cp && liveEval.cp > 0
                                      ? "text-cyan-400"
                                      : "text-white"
                                  }>
                                  {liveEval.cp
                                    ? (liveEval.cp > 0 ? "+" : "") +
                                      (liveEval.cp / 100).toFixed(2)
                                    : "0.00"}
                                </span>
                              )}
                            </div>
                            <div className="mt-3 text-center">
                              <div className="text-[9px] text-slate-500 uppercase tracking-widest">
                                Best Move
                              </div>
                              <div className="text-sm font-bold font-mono text-purple-400 bg-purple-400/10 px-3 py-1 rounded-md mt-1 border border-purple-400/20">
                                {liveEval.bestMove || "—"}
                              </div>
                            </div>
                          </div>
                          <AccuracyRing
                            value={
                              liveEval.mate
                                ? liveEval.mate < 0
                                  ? 100
                                  : 0
                                : 100 - rawAdvantage
                            }
                            color="#a78bfa"
                            label="B-Adv"
                          />
                        </div>
                      </div>
                    )}

                    <MultiPVPanel
                      pvLines={liveEval.pvLines}
                      isWhiteTurn={isWhiteTurn}
                    />

                    {analysisData && (
                      <div className="flex flex-col gap-1.5 shrink-0 mt-2">
                        <SectionHeader
                          icon={<Zap size={12} />}
                          label="Rangkuman Kualitas Langkah"
                        />
                        <div className="flex flex-col gap-1">
                          {GRADES.map((g) => {
                            const wc = distW[g.key] ?? 0;
                            const bc = distB[g.key] ?? 0;
                            if (wc === 0 && bc === 0) return null;
                            return (
                              <div
                                key={g.key}
                                className="grid grid-cols-[2rem_1fr_2rem] items-center p-1 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-all">
                                <span
                                  className={`text-center font-mono text-xs font-bold ${wc > 0 ? "text-white" : "text-white/15"}`}>
                                  {wc}
                                </span>
                                <div
                                  className={`flex items-center justify-center gap-2 ${g.color}`}>
                                  <div
                                    className={`w-3 h-3 rounded-md ${g.bg} flex items-center justify-center font-bold text-xs border shrink-0`}>
                                    {g.symbol}
                                  </div>
                                  <span className="font-semibold text-[10px] tracking-wide w-16 text-center opacity-90">
                                    {g.label}
                                  </span>
                                </div>
                                <span
                                  className={`text-center font-mono text-xs font-bold ${bc > 0 ? "text-white" : "text-white/15"}`}>
                                  {bc}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {analysisData?.criticalMoments &&
                      analysisData.criticalMoments.length > 0 && (
                        <div className="flex flex-col gap-2 p-3 rounded-xl bg-white/5 border border-white/10 shrink-0 mt-2">
                          <SectionHeader
                            icon={<AlertTriangle size={12} />}
                            label={`Critical Moments (${analysisData.criticalMoments.length})`}
                          />
                          <div className="flex flex-wrap gap-1.5">
                            {analysisData.criticalMoments.map((idx) => (
                              <button
                                key={idx}
                                onClick={() => goToMove(idx)}
                                className="px-2.5 py-1 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 text-[10px] font-mono font-bold hover:bg-red-500 hover:text-white transition-all">
                                Move {idx + 1}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                  </>
                )}

                {/* ── Position panel ───────────────────────────────────────── */}
                {activePanel === "position" && (
                  <>
                    {currentMoveAnalysis ? (
                      <>
                        <MoveExplanationPanel analysis={currentMoveAnalysis} />
                        <div className="flex flex-col gap-2 p-3 rounded-xl bg-white/5 border border-white/10">
                          <SectionHeader
                            icon={<Target size={12} />}
                            label="Material Balance"
                          />
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 w-8">
                              Bal.
                            </span>
                            <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden relative">
                              <div className="absolute inset-y-0 left-1/2 w-0.5 bg-white/10" />
                              <div
                                className={`absolute top-0 h-full rounded-full transition-all duration-500 ${currentMoveAnalysis.materialBalance > 0 ? "bg-cyan-400" : "bg-purple-400"}`}
                                style={{
                                  width: `${Math.min(50, Math.abs(currentMoveAnalysis.materialBalance) * 2)}%`,
                                  left:
                                    currentMoveAnalysis.materialBalance > 0
                                      ? "50%"
                                      : `${50 - Math.min(50, Math.abs(currentMoveAnalysis.materialBalance) * 2)}%`,
                                }}
                              />
                            </div>
                            <span
                              className={`text-xs font-mono font-bold w-10 text-right ${currentMoveAnalysis.materialBalance > 0 ? "text-cyan-400" : currentMoveAnalysis.materialBalance < 0 ? "text-purple-400" : "text-slate-400"}`}>
                              {currentMoveAnalysis.materialBalance > 0
                                ? "+"
                                : ""}
                              {currentMoveAnalysis.materialBalance}
                            </span>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-slate-600 gap-3">
                        <Target size={32} />
                        <p className="text-sm text-center">
                          Navigasi ke suatu langkah untuk melihat data
                          posisinya, Bre.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* ── Moves panel ──────────────────────────────────────────── */}
                {activePanel === "moves" && (
                  <div className="flex flex-col flex-1">
                    <SectionHeader
                      icon={<FileCode2 size={12} />}
                      label="History Langkah"
                    />
                    <div className="bg-[#050505] border border-white/10 rounded-2xl overflow-hidden flex flex-col h-full mt-2">
                      <div className="grid grid-cols-[3rem_1fr_1fr] text-[10px] font-bold text-slate-500 bg-white/5 border-b border-white/10 shrink-0 uppercase tracking-widest">
                        <div className="py-2 text-center border-r border-white/10">
                          #
                        </div>
                        <div className="py-2 px-3 border-r border-white/10">
                          Putih
                        </div>
                        <div className="py-2 px-3">Hitam</div>
                      </div>
                      <div
                        className="flex flex-col overflow-y-auto max-h-125"
                        ref={moveListRef}>
                        {pairedMoves.length === 0 ? (
                          <div className="p-4 text-center text-xs text-slate-500">
                            Belum ada pergerakan.
                          </div>
                        ) : (
                          pairedMoves.map(({ no, wIdx, bIdx }) => {
                            const wGrade = analysisData?.moveAnalyses[wIdx];
                            const bGrade =
                              bIdx !== null
                                ? analysisData?.moveAnalyses[bIdx]
                                : null;
                            return (
                              <div
                                key={no}
                                className="grid grid-cols-[3rem_1fr_1fr] text-[13px] border-b border-white/5 transition-colors">
                                <div className="py-2 text-slate-600 font-mono text-center border-r border-white/10 bg-white/5 flex items-center justify-center text-[11px]">
                                  {no}.
                                </div>
                                <button
                                  data-idx={wIdx}
                                  onClick={() => goToMove(wIdx)}
                                  className={`py-2 px-3 text-left font-mono font-medium transition-colors border-r border-white/10 flex items-center gap-1.5 ${
                                    currentMoveIdx === wIdx
                                      ? "text-cyan-400 bg-cyan-400/10"
                                      : "text-white/80 hover:text-cyan-400 hover:bg-white/5"
                                  }`}>
                                  {wGrade && (
                                    <span
                                      className={`text-[10px] ${getGradeDisplay(wGrade.grade).color}`}>
                                      {getGradeDisplay(wGrade.grade).symbol}
                                    </span>
                                  )}
                                  {positions[wIdx + 1]?.move ?? ""}
                                </button>
                                <button
                                  data-idx={bIdx ?? undefined}
                                  onClick={() =>
                                    bIdx !== null && goToMove(bIdx)
                                  }
                                  disabled={bIdx === null}
                                  className={`py-2 px-3 text-left font-mono font-medium transition-colors flex items-center gap-1.5 ${
                                    currentMoveIdx === bIdx
                                      ? "text-purple-400 bg-purple-400/10"
                                      : "text-white/80 hover:text-purple-400 hover:bg-white/5"
                                  }`}>
                                  {bGrade && (
                                    <span
                                      className={`text-[10px] ${getGradeDisplay(bGrade.grade).color}`}>
                                      {getGradeDisplay(bGrade.grade).symbol}
                                    </span>
                                  )}
                                  {bIdx !== null
                                    ? (positions[bIdx + 1]?.move ?? "")
                                    : ""}
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <RecentGamesModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        username={usernameInput}
        games={fetchedGames}
        onSelectGame={handleSelectGameFromModal}
      />
      <AnalysisProgressModal
        isOpen={isAnalyzing}
        progress={analysisProgress}
        onCancel={handleCancelAnalysis}
      />
    </div>
  );
}
