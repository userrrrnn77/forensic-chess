# Forensic Chess

Analisis game catur mendalam langsung di browser — parse PGN, evaluasi tiap langkah pakai engine catur WASM custom (**Reckless**), dan dapatkan grading per langkah (brilliant, great, best, mistake, blunder, dll) lengkap dengan penjelasan, akurasi, opening detection, dan deteksi momen kritis.

Semua analisis jalan **100% lokal** di browser via Web Worker — tidak ada PGN yang dikirim ke server manapun.

## ✨ Fitur

- **Engine WASM sendiri** — Reckless, dijalankan via Web Worker pool (paralel) tanpa nge-block main thread.
- **Grading per langkah** — `brilliant`, `great`, `best`, `excellent`, `good`, `inaccuracy`, `mistake`, `blunder`, `forced`, `miss`.
- **Deteksi sacrifice** — bedain brilliant move karena korban material vs quiet only-move.
- **Akurasi** — dihitung pakai harmonic mean, lebih realistis menghukum blunder tunggal dibanding rata-rata biasa.
- **Tablebase endgame** — query otomatis ke Lichess Syzygy tablebase untuk posisi ≤7 piece.
- **Opening detection** — deteksi nama opening & kode ECO dari urutan langkah.
- **Analisis fase game** — opening / middlegame / endgame breakdown.
- **Critical moments & best streak** — momen-momen penting dan rangkaian langkah terbaik dalam game.
- **Streaming analysis** — hasil langkah-per-langkah bisa ditampilkan incremental ke UI.

## 🛠️ Tech Stack

| Layer | Tools |
|---|---|
| Framework | React 19 + Vite |
| Bahasa | TypeScript |
| Styling | Tailwind CSS v4 |
| Catur | chess.js, react-chessboard |
| Engine | Reckless (WASM, custom) |
| Icons | lucide-react, react-icons |
| Package manager | Bun |
| Lint | oxlint |

## 📦 Instalasi

```bash
bun install
```

## 🚀 Menjalankan

```bash
bun dev          # dev server
bun run build    # build production
bun run preview  # preview hasil build
bun run lint      # lint dengan oxlint
```

## 📁 Struktur Project

```
src/
├── App.tsx                    # Root component
├── engine/
│   ├── chessAnalyzer.ts       # Orchestrator analisis (parse PGN → eval → grading)
│   ├── reckless.worker.ts     # Web Worker — bridge UCI ↔ engine WASM
│   └── pkg/                   # Build output WASM engine (Reckless)
├── types/                     # Tipe data (MoveAnalysis, AnalysisData, dll)
└── utils/
    ├── moduleChess.ts         # Konstanta engine, classifier move, evaluator posisi, worker factory
    └── logger.ts              # Logger sederhana berprefix [reckless:scope]
```

## 🧠 Cara Kerja Singkat

1. **Parse** — PGN diparse via `chess.js`, hasilkan urutan FEN sebelum/sesudah tiap langkah.
2. **Evaluasi** — tiap posisi dikirim ke pool Web Worker yang menjalankan engine Reckless (UCI protocol), dengan multi-PV dan movetime adaptif sesuai fase game.
3. **Tablebase** — kalau sisa piece ≤ 7, query Lichess Syzygy tablebase dulu sebelum search engine.
4. **Klasifikasi** — `cpLoss` antara eval sebelum/sesudah dipakai untuk grading, lalu dicek lebih lanjut untuk brilliant/great/forced lewat analisis gap PV dan deteksi sacrifice.
5. **Agregasi** — akurasi per warna, distribusi grade, opening, fase game, dan momen kritis dirangkum jadi satu `AnalysisData`.
