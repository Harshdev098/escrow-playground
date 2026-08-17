export const Outcome = { RELEASE: "Release", REFUND: "Refund" } as const;
export type OutcomeType = (typeof Outcome)[keyof typeof Outcome];

export const ContractStatus = {
    ACTIVE: "Active",
    RELEASED: "Released",
    REFUNDED: "Refunded",
} as const;

export type ContractStatusType = (typeof ContractStatus)[keyof typeof ContractStatus];

export interface Payout {
    to: "seller" | "buyer" | "arbiter";
    amount: number;
    note?: string;
}

export interface EscrowEvent {
    id: string;
    at: number;
    actor: string;
    label: string;
    authRequired: string;
    valid: boolean;
    reason: string;
    payout: Payout | null;
}

export interface EscrowState {
    escrowId: string;
    contractHash: string;
    amount: number;
    arbiterFee: number;
    timeoutSeconds: number;
    createdAt: number;
    timeoutAt: number;
    status: ContractStatusType;
    pendingArbiterFee: number | null;
    events: EscrowEvent[];
}

export interface CreateEscrowStateConfig {
    amount?: number;
    timeoutSeconds?: number;
    arbiterFee?: number;
}

export interface BuyerReleaseAction {
    type: "BUYER_RELEASE";
    actor: string;
    label: string;
    authRequired: string;
}

export interface SellerWithdrawUnauthorizedAction {
    type: "SELLER_WITHDRAW_UNAUTHORIZED";
    actor: string;
    label: string;
    authRequired: string;
}

export interface ArbiterDecisionAction {
    type: "ARBITER_DECISION";
    outcome: OutcomeType;
    actor: string;
    label: string;
    authRequired: string;
}

export interface ArbiterDecisionBadSigAction {
    type: "ARBITER_DECISION_BAD_SIG";
    actor: string;
    label: string;
    authRequired: string;
}

export interface ArbiterFeeClaimAction {
    type: "ARBITER_FEE_CLAIM";
    actor: string;
    label: string;
    authRequired: string;
}

export interface ArbiterFeeClaimBadSigAction {
    type: "ARBITER_FEE_CLAIM_BAD_SIG";
    actor: string;
    label: string;
    authRequired: string;
}

export interface ArbiterFeeClaimTooEarlyAction {
    type: "ARBITER_FEE_CLAIM_TOO_EARLY";
    actor: string;
    label: string;
    authRequired: string;
}

export interface TimeoutNoopAction {
    type: "TIMEOUT_NOOP";
    actor: string;
    label: string;
    authRequired: string;
}

export type EscrowAction =
    | BuyerReleaseAction
    | SellerWithdrawUnauthorizedAction
    | ArbiterDecisionAction
    | ArbiterDecisionBadSigAction
    | ArbiterFeeClaimAction
    | ArbiterFeeClaimBadSigAction
    | ArbiterFeeClaimTooEarlyAction
    | TimeoutNoopAction;

export interface ActionEvaluation {
    valid: boolean;
    reason: string;
    nextStatus?: ContractStatusType;
    payout?: Payout;
    setPendingFee?: number | null;
    noop?: boolean;
}

export function createEscrowState({
    amount = 100,
    timeoutSeconds = 60,
    arbiterFee = 2,
}: CreateEscrowStateConfig = {}): EscrowState {
    return {
        escrowId: "esc_" + Math.random().toString(16).slice(2, 10),
        contractHash: "0x" + Math.random().toString(16).slice(2, 10) + "…",
        amount,
        arbiterFee,
        timeoutSeconds,
        createdAt: Date.now(),
        timeoutAt: Date.now() + timeoutSeconds * 1000,
        status: ContractStatus.ACTIVE,
        pendingArbiterFee: null,
        events: [],
    };
}

export function evaluateAction(state: EscrowState, action: EscrowAction): ActionEvaluation {
    const timedOut = Date.now() >= state.timeoutAt;
    const terminal = state.status !== ContractStatus.ACTIVE;

    switch (action.type) {
        case "BUYER_RELEASE": {
            if (terminal) {
                return {
                    valid: false,
                    reason: `Contract is already terminal (${state.status}). load_contract still finds the row, but its status is no longer Active, so a second resolution is not a "wrong signature," it's not a defined transition anymore.`,
                };
            }
            return {
                valid: true,
                reason:
                    "verify_signature(buyer_key, msg_bytes, buyer_signature) passes. Contract got in released state and pays the FULL amount to seller_key — there's no arbiter_fee subtraction on this path, because the arbiter was never involved. Note: unlike the arbiter's authority, the buyer's signature is never time-gated — it verifies before or after the timeout, at any point the contract is still Active.",
                nextStatus: ContractStatus.RELEASED,
                payout: { to: "seller", amount: state.amount },
                setPendingFee: null,
            };
        }

        case "SELLER_WITHDRAW_UNAUTHORIZED": {
            return {
                valid: false,
                reason:
                    "There is no Resolution variant the seller can construct alone. Resolution is BuyerRelease, ArbiterOutcome, or ArbiterFeeClaim — every one of them requires a signature the seller doesn't hold.",
            };
        }

        case "ARBITER_DECISION": {
            if (terminal) {
                return {
                    valid: false,
                    reason: `Contract is already terminal (${state.status}). escrow_id was consumed by the first resolution — the module has no record of an "Active" contract to load anymore.`,
                };
            }
            if (!timedOut) {
                return {
                    valid: false,
                    reason:
                        'anyhow::ensure!(now >= contract.timeout, "arbiter cannot act before timeout") runs before the transaction is even built, and process_input re-checks it server-side too. Both layers refuse — no arbiter signature verifies yet, so there is nothing for a winner to submit.',
                };
            }
            const outcome = action.outcome;
            const payoutAmount = state.amount - state.arbiterFee;
            return {
                valid: true,
                reason: `verify_signature(arbiter_key, msg_bytes, arbiter_signature) passes for resolution_message(${outcome}). The arbiter signed this off-chain; the winning party is the one submitting it here. The winner is paid amount − arbiter_fee (${payoutAmount}) immediately, and a PendingArbiterFee row is written for the remaining ${state.arbiterFee} — the arbiter doesn't receive that yet, they have to claim it separately.`,
                nextStatus: outcome === Outcome.RELEASE ? ContractStatus.RELEASED : ContractStatus.REFUNDED,
                payout: {
                    to: outcome === Outcome.RELEASE ? "seller" : "buyer",
                    amount: payoutAmount,
                },
                setPendingFee: state.arbiterFee,
            };
        }

        case "ARBITER_DECISION_BAD_SIG": {
            return {
                valid: false,
                reason:
                    "verify_signature reconstructs resolution_message(outcome) from the outcome declared in the input and checks it against arbiter_key. If the signature doesn't match — whether it's outright invalid or was produced for a different outcome",
            };
        }

        case "ARBITER_FEE_CLAIM_TOO_EARLY": {
            return {
                valid: false,
                reason:
                    "There is nothing for the arbiter to claim, ever, on this path.",
            };
        }

        case "ARBITER_FEE_CLAIM": {
            if (state.pendingArbiterFee == null) {
                return {
                    valid: false,
                    reason:
                        "No PendingArbiterFee row exists for this escrow_id — either it was already claimed, or (as on the happy path) an arbiter decision never ran to create one.",
                };
            }
            const fee = state.pendingArbiterFee;
            return {
                valid: true,
                reason: `A fresh signature is checked here — this is a separate message (ArbiterFeeClaim{ escrow_id, fee_amount }), not a reuse of the resolution signature. verify_signature(arbiter_key, ...) passes, the ${fee}-sat fee is paid to the arbiter, and the PendingArbiterFeeKey row is deleted so it can't be claimed twice.`,
                payout: { to: "arbiter", amount: fee, note: "fee claim" },
                setPendingFee: null,
            };
        }

        case "ARBITER_FEE_CLAIM_BAD_SIG": {
            return {
                valid: false,
                reason:
                    "The fee claim requires its own valid arbiter signature over the ArbiterFeeClaim message — reusing or forging a signature here fails verify_signature and the pending fee stays exactly where it was, unclaimed.",
            };
        }

        case "TIMEOUT_NOOP": {
            if (!timedOut) {
                return {
                    valid: false,
                    reason: "Timeout has not elapsed yet. Nothing changes automatically before then — the contract simply continues waiting for a buyer release.",
                };
            }
            return {
                valid: true,
                reason:
                    "Timeout has elapsed. This does not move funds by itself — it only changes which signatures the module will accept: the buyer's Release signature closes, the arbiter's signature opens.",
                nextStatus: state.status,
                payout: undefined,
                noop: true,
            };
        }

        default:
            return { valid: false, reason: "Unrecognized action." };
    }
}

/** Applies an evaluated action to state, producing the next state + a log entry. */
export function applyAction(
    state: EscrowState,
    action: EscrowAction,
    evaluation: ActionEvaluation,
    now = Date.now(),
): { next: EscrowState; entry: EscrowEvent } {
    const entry: EscrowEvent = {
        id: "evt_" + Math.random().toString(16).slice(2, 8),
        at: now,
        actor: action.actor,
        label: action.label,
        authRequired: action.authRequired,
        valid: evaluation.valid,
        reason: evaluation.reason,
        payout: evaluation.payout || null,
    };

    if (!evaluation.valid || evaluation.noop) {
        return { next: state, entry };
    }

    const next: EscrowState = {
        ...state,
        status: evaluation.nextStatus ?? state.status,
        pendingArbiterFee:
            evaluation.setPendingFee !== undefined ? evaluation.setPendingFee : state.pendingArbiterFee,
    };
    return { next, entry };
}

/* ============================================================================
   PACKET MODEL
   Inspired by fedimint-playground's design: every protocol action becomes a
   Packet that PARKS at its sender until the user approves it, then animates
   to the federation and back with a real/rejected response. The user is the
   network — nothing fires automatically. Packets carry inspectable payload
   fields mirroring the real Rust types (EscrowOutput/EscrowInput/Resolution).
   ============================================================================ */

export type PartyId = "buyer" | "seller" | "arbiter" | "federation";

export type PacketStatus = "parked" | "in-flight" | "returning" | "accepted" | "rejected";

export interface PacketField {
    key: string;
    value: string;
}

export interface PacketDef {
    id: string;
    from: PartyId;
    /** Where this packet travels to. Defaults to "federation" (an on-chain submission).
        "buyer" -> "seller" is used for the off-chain signature hand-off before the
        seller submits it on-chain themselves. */
    to: PartyId;
    /** False for an off-chain hand-off (e.g. buyer sharing a signature with the seller) —
        no federation verification happens, so there's no accept/reject outcome, just a relay. */
    submits: boolean;
    /** What kind of domain action this packet performs when approved. Only meaningful when submits is true. */
    action: EscrowAction;
    /** Short label shown on the packet chip, e.g. "EscrowOutput". */
    kind: string;
    /** One-line human label, e.g. "Create escrow contract". */
    title: string;
    /** Inspectable payload fields shown when the packet is clicked. */
    fields: PacketField[];
}

export interface PacketInstance extends PacketDef {
    status: PacketStatus;
    /** Filled in once the packet resolves. */
    result?: {
        valid: boolean;
        reason: string;
        payout?: Payout;
    };
}

function fieldsForAction(state: EscrowState, action: EscrowAction): PacketField[] {
    switch (action.type) {
        case "BUYER_RELEASE":
            return [
                { key: "escrow_id", value: state.escrowId },
                { key: "resolution", value: "BuyerRelease { buyer_signature }" },
                { key: "message signed", value: `hash(federation_id, escrow_id, Release, contract_hash)` },
            ];
        case "SELLER_WITHDRAW_UNAUTHORIZED":
            return [
                { key: "escrow_id", value: state.escrowId },
                { key: "resolution", value: "— (no variant exists for this)" },
                { key: "signing key used", value: "seller_key (insufficient — not a recognized authority for any Resolution)" },
            ];
        case "ARBITER_DECISION":
            return [
                { key: "escrow_id", value: state.escrowId },
                { key: "resolution", value: `ArbiterOutcome { outcome: ${action.outcome}, arbiter_signature }` },
                { key: "message signed", value: `hash(federation_id, escrow_id, ${action.outcome}, contract_hash)` },
                { key: "requires", value: "now >= contract.timeout" },
            ];
        case "ARBITER_DECISION_BAD_SIG":
            return [
                { key: "escrow_id", value: state.escrowId },
                { key: "resolution", value: "ArbiterOutcome { outcome, arbiter_signature: <invalid> }" },
                { key: "signature", value: "does not verify against arbiter_key" },
            ];
        case "ARBITER_FEE_CLAIM":
        case "ARBITER_FEE_CLAIM_TOO_EARLY":
            return [
                { key: "escrow_id", value: state.escrowId },
                { key: "resolution", value: "ArbiterFeeClaim { arbiter_signature }" },
                { key: "message signed", value: "hash(escrow_id, fee_amount) — independent of the resolution signature" },
                { key: "requires", value: "a PendingArbiterFee row to exist for this escrow_id" },
            ];
        case "ARBITER_FEE_CLAIM_BAD_SIG":
            return [
                { key: "escrow_id", value: state.escrowId },
                { key: "resolution", value: "ArbiterFeeClaim { arbiter_signature: <invalid> }" },
                { key: "signature", value: "does not verify against arbiter_key" },
            ];
        case "TIMEOUT_NOOP":
            return [{ key: "note", value: "not a submitted packet — the clock simply advances" }];
        default:
            return [];
    }
}

/** Payload fields for the off-chain hand-off: the buyer's raw signature, before
    the seller wraps it into an EscrowInput and submits it themselves. */
export function relaySignatureFields(state: EscrowState): PacketField[] {
    return [
        { key: "escrow_id", value: state.escrowId },
        { key: "buyer_signature", value: "sig_" + "7c2a91…" + " (over outcome=Release)" },
        { key: "delivered via", value: "out-of-band — not a federation transaction" },
        { key: "next step", value: "seller wraps this into EscrowInput and submits it" },
    ];
}

/** Payload fields for the arbiter's off-chain hand-off to the winning party — a
    signature over their decided outcome, not yet submitted anywhere. */
export function arbiterRelayFields(state: EscrowState, outcome: OutcomeType, winner: "buyer" | "seller"): PacketField[] {
    return [
        { key: "escrow_id", value: state.escrowId },
        { key: "arbiter_signature", value: "sig_" + "e91fa3…" + ` (over outcome=${outcome})` },
        { key: "delivered via", value: `out-of-band, to the ${winner} — not a federation transaction` },
        { key: "next step", value: `${winner} wraps this into EscrowInput and submits it` },
    ];
}

/** Payload fields for the creation packet — always the buyer's first move. */
export function creationFields(cfg: { amount: number; arbiterFee: number; timeoutSeconds: number }): PacketField[] {
    return [
        { key: "buyer_key", value: "bk_" + "a1b2c3…" },
        { key: "seller_key", value: "sk_" + "d4e5f6…" },
        { key: "arbiter_key", value: "ak_" + "9f8e7d…" },
        { key: "amount", value: `${cfg.amount} ecash` },
        { key: "arbiter_fee", value: `${cfg.arbiterFee} ecash` },
        { key: "timeout", value: `${cfg.timeoutSeconds}s from now` },
        { key: "contract_hash", value: "hash(buyer_key, seller_key, arbiter_key, amount, timeout, federation_id)" },
    ];
}

/** Builds a packet definition for a given action, with real inspectable fields.
    Defaults to an on-chain submission straight to the federation; pass to/submits
    explicitly for an off-chain relay hop (e.g. buyer -> seller). */
export function buildPacket(
    id: string,
    from: PartyId,
    action: EscrowAction,
    kind: string,
    title: string,
    state: EscrowState,
    opts?: { to?: PartyId; submits?: boolean },
): PacketDef {
    return {
        id,
        from,
        to: opts?.to ?? "federation",
        submits: opts?.submits ?? true,
        action,
        kind,
        title,
        fields: fieldsForAction(state, action),
    };
}

/* ============================================================================
   LIVE AUTHORIZATION STATUS
   Computes, at any instant, whether each actor's canonical action is
   currently valid and why. This is the core teaching primitive: instead of
   explaining only the action just taken, it explains the whole board,
   continuously, so "what can happen right now and why" never requires a click.
   ============================================================================ */

export interface ActorStatus {
    actor: "buyer" | "seller" | "arbiter" | "arbiter-fee";
    label: string;
    actionLabel: string;
    live: boolean;
    reason: string;
}

export function computeLiveStatus(state: EscrowState, now: number): ActorStatus[] {
    const timedOut = now >= state.timeoutAt;
    const terminal = state.status !== ContractStatus.ACTIVE;

    const buyer: ActorStatus = terminal
        ? { actor: "buyer", label: "Buyer", actionLabel: "Sign release", live: false, reason: `Contract is ${state.status.toLowerCase()} — escrow_id is consumed, no signature moves these funds again.` }
        : {
            actor: "buyer",
            label: "Buyer",
            actionLabel: "Sign release",
            live: true,
            reason:
                "Buyer's signature over outcome=Release verifies right now, and always will while the contract is Active — this path is never time-gated, before or after the timeout.",
        };

    const seller: ActorStatus = {
        actor: "seller",
        label: "Seller",
        actionLabel: "Withdraw directly",
        live: false,
        reason: "No Resolution variant exists that the seller can construct alone — this is never live, at any point in the contract's life.",
    };

    const arbiter: ActorStatus = terminal
        ? { actor: "arbiter", label: "Arbiter", actionLabel: "Decide outcome", live: false, reason: `Contract is ${state.status.toLowerCase()} — a decision has already been recorded, if one was ever needed.` }
        : {
            actor: "arbiter",
            label: "Arbiter",
            actionLabel: "Decide outcome",
            live: timedOut,
            reason: timedOut
                ? "Timeout has passed. now >= contract.timeout holds, so the arbiter's signature over an outcome now verifies — in practice they'd sign and relay it to the winner, who submits it; this board shows the signature becoming valid, not who submits it."
                : "Timeout hasn't passed. Both client and server refuse to even check an arbiter signature yet.",
        };

    const arbiterFee: ActorStatus = {
        actor: "arbiter-fee",
        label: "Arbiter",
        actionLabel: "Claim fee",
        live: state.pendingArbiterFee != null,
        reason:
            state.pendingArbiterFee != null
                ? `A PendingArbiterFee row of ${state.pendingArbiterFee} exists for this escrow_id — the arbiter can claim it with a fresh signature at any time now.`
                : state.status === ContractStatus.RELEASED && terminal
                    ? "This escrow resolved via buyer release, which never creates a pending fee — there's nothing here to claim."
                    : "No pending fee exists yet. This only appears after an arbiter decision has resolved the contract.",
    };

    return [buyer, seller, arbiter, arbiterFee];
}

/* ============================================================================
   GUIDED SCRIPT
   A fixed sequence of steps used to teach the protocol before sandbox mode
   unlocks. Each step either presents ONE packet to approve (packetAction set)
   or is a pure wait/fork step with no packet (packetAction undefined). This
   mirrors fedimint-playground's model: the user releases the network one
   packet at a time, and every packet is inspectable before/after approval.
   Two branches after the fork: happy path (buyer release, fee claim never
   exists) and dispute path (timeout -> arbiter decision -> fee claim).
   ============================================================================ */

export type StepId =
    | "create"
    | "fork"
    | "happy-sign-relay"
    | "happy-seller-submits"
    | "wait-timeout"
    | "dispute-sign-relay"
    | "dispute-winner-submits"
    | "fee-claim"
    | "done";

export interface ScriptStep {
    id: StepId;
    eyebrow: string;
    title: string;
    body: string;
    /** If set, this step's action is what gets packaged into a packet the user approves. */
    packet?: {
        from: PartyId;
        to?: PartyId;
        submits?: boolean;
        kind: string;
        packetTitle: string;
        action: EscrowAction;
    };
    /** Steps with no packet are pure "continue"/fork beats (e.g. waiting, choosing). */
    isWait?: boolean;
    isTerminal?: boolean;
}

export const SCRIPT_STEPS: Record<StepId, ScriptStep> = {
    create: {
        id: "create",
        eyebrow: "Step 1",
        title: "Click the buyer's packet to create the contract",
        body:
            "Nothing exists yet. The buyer builds an Escrow Contract naming all three keys, the amount, arbiter_fee, and timeout. Click the parked packet below to inspect it, then approve it to send it to the federation. The federation responds with an operation_id confirming the contract is stored.",
        packet: { from: "buyer", kind: "EscrowOutput", packetTitle: "Create escrow contract", action: { type: "BUYER_RELEASE", actor: "buyer", label: "__CREATE__", authRequired: "" } },
    },
    fork: {
        id: "fork",
        eyebrow: "Step 2 — the only live path",
        title: "Right now, only the buyer can move these funds",
        body:
            "After the successfull delivery of goods/services, the seller has no authority to release the contract locked funds without the buyer signatures. The arbiter's signature won't verify before teh timeout reaches.",
        isWait: true,
    },
    "happy-sign-relay": {
        id: "happy-sign-relay",
        eyebrow: "Happy path — Step 3",
        title: "Buyer signs, and hands the signature to the seller",
        body:
            "This is not a federation transaction yet — it's an off-chain hand-off. outcome is hardcoded to Release for a buyer signature, so there's no field to tamper with. Approve it to watch the signature travel from buyer to seller.",
        packet: {
            from: "buyer",
            to: "seller",
            submits: false,
            kind: "buyer_signature",
            packetTitle: "Signed release, shared off-chain",
            action: { type: "BUYER_RELEASE", actor: "buyer", label: "Buyer signs release to Seller", authRequired: "Buyer signature" },
        },
    },
    "happy-seller-submits": {
        id: "happy-seller-submits",
        eyebrow: "Happy path — Step 4",
        title: "The seller wraps it and submits to the federation",
        body:
            "The seller is the one who actually submits the transaction, once they're holding a valid buyer signature. After the verification, federation pays the seller the full 100 ecash, and the escrow's locked balance goes to zero.",
        packet: {
            from: "seller",
            kind: "EscrowInput",
            packetTitle: "BuyerRelease → Seller",
            action: { type: "BUYER_RELEASE", actor: "buyer", label: "Buyer signs release to Seller", authRequired: "Buyer signature" },
        },
    },
    "wait-timeout": {
        id: "wait-timeout",
        eyebrow: "Dispute path — Step 3",
        title: "The buyer stays silent. Advance the clock.",
        body: "No packet is sent here — nothing happens automatically. Click to fast-forward past the timeout and watch the authority gate flip.",
        isWait: true,
    },
    "dispute-sign-relay": {
        id: "dispute-sign-relay",
        eyebrow: "Dispute path — Step 4",
        title: "The arbiter signs an outcome, and shares it with the winner",
        body:
            "The arbiter never submits anything to the federation directly. They review evidence off-chain, sign a message covering the outcome, and hand that signature to whichever party won — here, choose the ruling and watch the signature travel to the winner.",
        isWait: true,
    },
    "dispute-winner-submits": {
        id: "dispute-winner-submits",
        eyebrow: "Dispute path — Step 5",
        title: "The winner submits the arbiter's signature",
        body:
            "Holding a valid arbiter signature, the winning party builds the ArbiterOutcome resolution themselves and submits it. Approve it: the federation pays the winner amount − arbiter_fee, and a pending fee is set aside for the arbiter to collect separately.",
    },
    "fee-claim": {
        id: "fee-claim",
        eyebrow: "Dispute path — Step 6",
        title: "The arbiter sends a second, separate packet: the fee claim",
        body:
            "This is not the same signature that resolved the dispute — it's a fresh signature over a different message (escrow_id + fee_amount), and the arbiter is the one who submits it themselves. Approve it to collect the fee.",
        packet: {
            from: "arbiter",
            kind: "EscrowInput",
            packetTitle: "ArbiterFeeClaim",
            action: { type: "ARBITER_FEE_CLAIM", actor: "arbiter", label: "Arbiter claims their fee", authRequired: "Arbiter signature (fresh, over ArbiterFeeClaim message)" },
        },
    },
    done: {
        id: "done",
        eyebrow: "Walkthrough complete",
        title: "You've now watched every packet this protocol sends",
        body: "",
        isTerminal: true,
    },
};


/* ============================================================================
   TRUST MODEL CONTENT
   Static content backing the Trust Model tab's can/cannot table and
   assumptions cards.
   ============================================================================ */

export interface TrustTableRow {
    actor: string;
    colorVar: string;
    can: string;
    cannot: string;
}

export const TRUST_TABLE: TrustTableRow[] = [
    {
        actor: "Buyer",
        colorVar: "--color-blue",
        can: "Authorize happy-path release with a signature, paying the seller the full amount",
        cannot: "Arbitrarily take funds from the seller, or release after the dispute window has opened",
    },
    {
        actor: "Seller",
        colorVar: "--color-primary",
        can: "Participate in the agreement; verify contract terms via escrow_id",
        cannot: "Unilaterally withdraw escrowed funds under any circumstance — no Resolution variant exists for this",
    },
    {
        actor: "Arbiter",
        colorVar: "--color-warning",
        can: "Authorize a dispute outcome after the timeout, then separately claim their fee with a second signature",
        cannot: "Act before the timeout, sign an outcome different from the one declared in the message, or claim a fee that was never created",
    },
    {
        actor: "Escrow module",
        colorVar: "--color-dark",
        can: "Verify signatures and enforce contract state transitions exactly once, including the separate fee-claim step",
        cannot: "Determine whether a real-world event (delivery, quality, fraud) actually happened",
    },
];

export interface TrustAssumption {
    to: string;
}

export const TRUST_ASSUMPTIONS: TrustAssumption[] = [
    { to: "Buyer honestly signs Release service have been fulfilled, otherwise the seller may need to wait for timeout and arbitration." },
    { to: "Arbiter makes a fair, evidence-based decision when a dispute is raised." },
    { to: "Winning party of dispute cooperates in submitting the arbiter's signed decision; otherwise, the escrow and arbiter fee may remain unresolved." },
    { to: "Seller fulfils the real-world obligation agreed outside the escrow; the protocol cannot verify delivery or service completion." },
];

export const NOT_REQUIRED: string[] = [
    "Real-world identities of buyer, seller, or arbiter",
    "The contents or substance of the dispute",
    "Whether the physical or digital good was actually delivered",
    "Why the arbiter decided the way it did",
];

/* ============================================================================
   ARCHITECTURE ESSAY CONTENT
   Prose meant to let a reader locate their own use case against the
   architecture's actual shape, without being asked anything — no fit-check
   questionnaire, just a clear-eyed account of the guarantees, edges, and
   composability of the design.
   ============================================================================ */

export interface EssaySection {
    id: string;
    heading: string;
    paragraphs: string[];
}

export const ARCHITECTURE_ESSAY: EssaySection[] = [
    {
        id: "guarantees",
        heading: "What this architecture actually guarantees",
        paragraphs: [
            "Three things are enforced by consensus code, not by anyone's good behavior. A contract's terms can't change after creation — they're baked into contract_hash, and the module independently recomputes and checks that hash before it will store the contract at all. A resolution can't be replayed or redirected — the signed message binds federation_id, escrow_id, the outcome, and contract_hash together, so a signature produced for one contract or one outcome fails verification anywhere else. And a resolved contract can never be spent twice — status moves from Active to a terminal state and stays there.",
            "That's narrower than 'the escrow is secure.' It's closer to: whatever authorization rule you agreed to at creation time is the one that gets enforced, exactly, with no room for a party to renegotiate it later by pressuring the module.",
        ],
    },
    {
        id: "outside",
        heading: "What's deliberately left outside the protocol",
        paragraphs: [
            "The module has no opinion on whether a delivery happened, whether goods matched description, or who was telling the truth in a dispute. It only ever answers one question: does this signature verify, for this contract, for this declared outcome, at this time? The arbiter's judgment is a black box to the code — evidence, conversation, and reasoning all happen off-chain, and the module enforces the result without inspecting how it was reached.",
            "This is a design choice, not a limitation waiting to be fixed. Encoding 'did delivery happen' into consensus code would mean the federation adjudicating real-world facts — a much bigger, different, and generally undesirable thing for a federation of guardians to be doing.",
        ],
    },
    {
        id: "fee-model",
        heading: "Why the arbiter fee is a separate step, not a side effect",
        paragraphs: [
            "It would be simpler for the module to just pay the arbiter their fee at the same moment it pays out the winner. Instead, an arbiter decision only writes a pending-fee record — the arbiter has to come back with a second, independently-verified signature to actually collect it. Structurally, this keeps the resolution transaction's job narrow (verify one signature, move funds to one winner) rather than bundling a second unrelated payout into it.",
            "It also means the fee genuinely doesn't exist as a concept on the buyer-release path. If the buyer signs happily before any dispute, the arbiter was never part of that transaction, so there's no pending record for them to claim later — a small but precise reflection of the principle that the arbiter is only paid for work they were actually asked to do.",
        ],
    },
    {
        id: "fits",
        heading: "Where this shape tends to fit",
        paragraphs: [
            "It fits naturally wherever you already have — or are willing to designate — some accountable party who can look at evidence and make a call, and where you're comfortable with that call being final once made. Freelance and marketplace payments, peer-to-peer trades, and any workflow with a natural mediator (a platform operator, a guild, a trusted intermediary) all match this shape well, because the hard part — judgment — was going to live off-chain regardless of what protocol you used.",
            "It also fits well anywhere the timeout is doing useful work: a buyer who goes silent shouldn't be able to freeze funds forever, and a seller shouldn't be able to force early arbitration before the buyer's had a fair window to just release the funds happily. The pre-timeout / post-timeout split exists specifically so the fast path stays fast and the slow path only opens once the fast path has had its chance.",
        ],
    },
    {
        id: "doesnt-fit",
        heading: "Where it doesn't fit",
        paragraphs: [
            "If your application needs the protocol itself to verify that a real-world event occurred — proof of delivery from a shipping API, an oracle-fed price at settlement, a cryptographic proof of work performed — this module doesn't do that, and bolting it on would mean adding exactly the kind of real-world-fact verification the design intentionally avoids. That's a different module, likely built around an oracle or attestation scheme, not this one.",
            "It also doesn't fit if a single arbiter having unilateral, unappealable authority over the outcome is unacceptable for your use case — today there's exactly one arbiter_key, one signature, one decision, with no on-protocol appeal step. If the dispute decision itself needs agreement among several parties rather than trust in one, you need multi-party authorization at the signing layer, which this contract shape doesn't yet provide.",
        ],
    },
    {
        id: "extends",
        heading: "How it composes and where it stops",
        paragraphs: [
            "The arbiter side of this is a single key today, but the signature-verification boundary is exactly where a threshold or multi-arbiter scheme would plug in — the module doesn't care how arbiter_key's signature got produced, only that it verifies. A key held by an actual committee behind the scenes, or a proper threshold signing scheme, is a change to how that one key is produced, not a change to the module's consensus logic.",
            "What doesn't compose as cleanly is stacking additional off-chain policy — reputation systems, appeal processes, weighted votes — directly into this module. Those are policy layers that sit above a settlement primitive like this one; encoding them into the consensus code would mean the federation enforcing business logic it has no way to evaluate, which runs against the whole premise of keeping the module's job narrow: verify signatures, enforce transitions, know nothing else.",
        ],
    },
];
