# Fedimint Escrow Playground

An interactive playground for understanding the **Fedimint trust-minimized escrow module** — not by reading docs, but by watching the actual protocol flow happen, exactly the way the real module handles them.

## What this is

A guided, animated walkthrough of the escrow contract lifecycle:

- **Create** a contract (buyer locks funds, federation returns an `operation_id`)
- **Happy path** — buyer signs a release, hands the signature to the seller off-chain, seller submits it
- **Dispute path** — timeout passes, arbiter signs an outcome and relays it to the winner off-chain, the winner submits it, arbiter claims their fee separately afterward
- **Try to break it** — send unauthorized withdrawals, bad signatures, and premature fee claims, and see exactly why the federation rejects each one


## ⚠️ Important: this is a protocol mirror, not a live client

This is **version 1** — a self-contained simulation. It does **not** call the Fedimint SDK, does **not** talk to a real federation to use any actual client/server escrow methods. All contract state, signature verification, and the flow are reimplemented client-side in TypeScript to *mirror* the real module's logic (`fedimint-escrow-server` / `fedimint-escrow-client`) for teaching purposes only.

**Version 2** will replace this simulated core with real calls through the Fedimint SDK once the escrow module is officially deployed!
## Structure

- `domain.ts` — protocol logic: state, authorization rules, the guided script, packet model
- `components.tsx` — UI: stage/animation, walkthrough, sandbox, trust model, architecture notes
- `App.css` — all styling
- `EscrowApp.tsx` — entry point

