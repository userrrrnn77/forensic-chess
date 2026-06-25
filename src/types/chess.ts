// src/types/chess.ts

export type MoveGrade =
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "forced"
  | "miss";

export interface LegacyEvalResult {
  cp: number | null;
  mate: number | null;
  bestMove: string | null;
  depth: number;
  source: "lichess" | "wasm" | "cache";
}

export interface LegacyMoveAnalysis {
  move: string;
  fen: string;
  cpLoss: number;
  grade: MoveGrade;
  color: "white" | "black";
  evalBefore: LegacyEvalResult | null;
  evalAfter: LegacyEvalResult | null;
  bestMove: string | null;
}

export interface GameAnalysisResult {
  jobId: string;
  pgn: string;
  moves: LegacyMoveAnalysis[];
  accuracy: number;
  accuracyByColor: { white: number; black: number };
  moveDistribution: Record<MoveGrade, number>;
  analysisDepth: "shallow" | "medium" | "deep";
  status: "pending" | "done" | "error";
  error?: string;
  createdAt: string | Date;
  completedAt?: string | Date;
}

export interface ChessCacheStats {
  size: number;
  maxSize: number;
  utilization: string;
}

export interface PositionData {
  fen: string;
  move: string | null;
}

export interface RawChessComGame {
  url?: string;
  pgn?: string;
  time_class?: string;
  end_time: number;
  white?: { username?: string; result?: string };
  black?: { username?: string; result?: string };
  [key: string]: unknown;
}

export interface ChessGameRecord {
  id: string;
  white: string;
  black: string;
  result: string;
  date: string;
  timeControl: string;
  pgn: string;
}

export interface TablebaseResult {
  dtz: number | null;
  dtm: number | null;
  bestMove: string | null;
  category: string | null;
}

export interface PVLine {
  depth: number;
  cp: number | null;
  mate: number | null;
  moves: string[];
}

export interface StockfishEvaluation {
  cp: number | null;
  mate: number | null;
  bestMove: string | null;
  ponder: string | null;
  depth: number;
  pvLines: PVLine[];
  nodes: number;
  nps: number;
  time: number;
}

export type DistributionKey = Exclude<MoveGrade, "forced" | "miss">;

export interface MoveAnalysis {
  moveIdx: number;
  move: string;
  fen: string;
  cpBefore: number;
  cpAfter: number;
  cpLoss: number;
  grade: MoveGrade;
  isBrilliant: boolean;
  isGreat: boolean;
  isBest: boolean;
  bestMoveSuggestion: string | null;
  phase: "opening" | "middlegame" | "endgame";
  materialBalance: number;
  pawnStructureScore: number;
  kingSafetyScore: number;
  pieceActivityScore: number;
  isTactical: boolean;
  tacticalTheme: string[];
  explanation: string;
}

export interface AnalysisData {
  accuracy: number;
  accuracyByColor: { white: number; black: number };
  moveDistribution: {
    white: Record<string, number>;
    black: Record<string, number>;
  };
  moveAnalyses: MoveAnalysis[];
  openingName: string | null;
  openingEco: string | null;
  gamePhases: { opening: number; middlegame: number; endgame: number };
  criticalMoments: number[];
  bestAccuracyStreak: {
    color: "white" | "black";
    length: number;
    from: number;
  };
}

export interface EvalResult {
  cp: number;
  pvLines: PVLine[];
}

export interface WorkerHealth {
  timeoutCount: number;
  isZombie: boolean;
}
