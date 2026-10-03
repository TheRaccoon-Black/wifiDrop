# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**WiFiDrop** — A single-file, serverless P2P file and text sharing app. Two browsers connect directly via WebRTC (PeerJS) using a 4-character room code — no uploads to any server.

## Usage

Open `index.html` in Chrome/Edge on two devices:
- **Host**: picks "Host" → gets 4-char code → shares with friend
- **Join**: picks "Gabung" → enters 4-char code → auto-connects

After connection: **both** sides can send files & text and receive from each other — no sender/receiver distinction.

## Project Structure

```
wifiDrop/
├── index.html   ← HTML structure, event handlers call app.*
├── styles.css   ← all CSS
└── app.js       ← WifiDropApp class + standalone utilities
```

## External Dependencies (CDN via jsdelivr)
- `peerjs@1.5.4` — WebRTC signaling
- `html5-qrcode@2.3.8` — camera QR scanner
- `qrcodejs@1.0.0` — real QR encoder for host's QR display

## Usage

Open `index.html` in Chrome/Edge on two devices:
- **Host**: picks "Host" → gets 4-char code → shares with friend
- **Join**: picks "Gabung" → enters 4-char code → auto-connects

After connection: **both** sides can send files & text and receive from each other — no sender/receiver distinction.

## Architecture

- Single HTML file split into 3 modules: HTML, CSS, JS
- **PeerJS** (CDN) handles WebRTC signaling; STUN only (no TURN)
- **Bidirectional** — single DataChannel used for send + receive on both sides
- No sender/receiver roles; just Host vs Join for initial connection

### State (WifiDropApp instance properties)
- `peer` — PeerJS instance
- `conn` — active DataChannel
- `mode` — `'host'` or `'join'`
- `files[]` — queued files to send
- `textItems[]` — text messages to send
- `receiving{}` — in-progress incoming files (id → {meta, chunks, received})
- `incomingTexts[]` — received text messages
- `hist[]` — localStorage key `wfd2hist`, max 60 entries

### Key Methods
- `initHost(code)` — host registers `wfd2-{code}` as PeerJS ID, waits for connection
- `doJoin(code)` — joiner connects to `wfd2-{code}`
- `_handleData(data)` — dispatches `identity`/`meta`/`done`/`text` JSON or binary chunks
- `sendAll()` — chunked transfer with 65536-byte chunks + back-pressure
- `sendTexts()` — batch send text items over DataChannel
- `genQr(text)` — generates real scannable QR via `qrcode-generator` lib
- `startScan()` / `stopScan()` — camera QR scanner via `html5-qrcode` lib

### DataChannel Protocol
JSON messages: `identity` | `meta` | `done` | `text`; raw binary: file chunks

### File Transfer Flow
1. `meta` JSON → creates incoming row with progress bar
2. Binary chunks → buffered and assembled
3. `done` JSON → Blob created, download triggered

## Development

No build step. Edit any module directly and refresh the browser.