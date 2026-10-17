export const Outcome = { RELEASE: "Release", REFUND: "Refund", SPLIT: "Split" } as const;
export type OutcomeType = (typeof Outcome)[keyof typeof Outcome];

export const ContractStatus = {
    ACTIVE: "Active",
    DISPUTED: "Disputed",
    RELEASED: "Released",
    REFUNDED: "Refunded",
    SPLIT: "Split",
} as const;
export type ContractStatusType = (typeof ContractStatus)[keyof typeof ContractStatus];

export type Role = "funder" | "recipient" | "arbiter";
export type PartyId = Role | "federation";
export type FallbackKind = "Refund" | "Split" | "SwapArbiter";
/**
 * valid  = made by the arbiter that is currently active
 * forged = not made by the arbiter's key at all
 * stale  = made by the ORIGINAL arbiter after it was swapped out
 */
export type Signature = "valid" | "forged" | "stale";

export const SPLIT_BPS_DENOMINATOR = 10000;
export const DEMO_SPLIT = { funderBps: 5000, recipientBps: 5000 } as const;

export const FALLBACK_OPTIONS: { kind: FallbackKind; label: string }[] = [
    { kind: "Refund", label: "Fallback: Refund" },
    { kind: "Split", label: "Fallback: Split 50 / 50" },
    { kind: "SwapArbiter", label: "Fallback: SwapArbiter" },
];

export type ErrorCode =
    | "ContractNotFound"
    | "AlreadyExists"
    | "ContractDisputed"
    | "ContractAlreadyResolved"
    | "InvalidSignature"
    | "TimeoutNotReached"
    | "ContractNotDisputed"
    | "ResolutionDeadlinePassed"
    | "FallbackNotAvailable"
    | "NoPendingClaim";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
    ContractNotFound: "Contract not found",
    AlreadyExists: "Contract already exists",
    ContractDisputed: "Contract is under dispute; funder release is no longer valid",
    ContractAlreadyResolved: "Contract already resolved, claim the amount if not!",
    InvalidSignature: "Invalid signature",
    TimeoutNotReached: "Timeout not reached",
    ContractNotDisputed: "Contract not disputed",
    ResolutionDeadlinePassed: "The resolution deadline has passed",
    FallbackNotAvailable: "Fallback resolution is not yet available",
    NoPendingClaim: "No pending claim",
};

export interface Payout {
    to: Role;
    amount: number;
    note?: string;
}

export interface ClaimEntry {
    party: Role;
    amount: number;
}

export interface EscrowConfig {
    amount: number;
    arbiterFee: number;
    /** Fee of the replacement arbiter (only used by the SwapArbiter fallback). */
    swapArbiterFee: number;
    timeoutSeconds: number;
    resolutionSeconds: number;
    defaultFallback: FallbackKind;
}

export const DEFAULT_CONFIG: EscrowConfig = {
    amount: 100,
    arbiterFee: 2,
    swapArbiterFee: 3,
    timeoutSeconds: 30,
    resolutionSeconds: 300,
    defaultFallback: "Refund",
};

export interface EscrowState {
    /** False until the creation packet has been accepted — nothing exists before that. */
    created: boolean;
    escrowId: string;
    contractHash: string;
    amount: number;
    arbiterFee: number;
    swapArbiterFee: number;
    timeoutSeconds: number;
    resolutionSeconds: number;
    defaultFallback: FallbackKind;
    /** Arbiter can be engaged once now >= timeoutAt. */
    timeoutAt: number;
    /** Set when the arbiter is engaged: the active arbiter's decision is only valid until then. */
    resolveBy: number | null;
    /** True once the SwapArbiter fallback has been used. It can only happen once. */
    swapped: boolean;
    status: ContractStatusType;
    /** Mirrors the server's ClaimPool: written by a resolution, drained by ClaimPayout. */
    claimPool: ClaimEntry[] | null;
    /** What the federation still holds for this escrow. */
    locked: number;
    /** Ecash wallets of the three parties. */
    wallets: Record<Role, number>;
}

export function createEscrowState(cfg: Partial<EscrowConfig> = {}): EscrowState {
    const c: EscrowConfig = { ...DEFAULT_CONFIG, ...cfg };
    return {
        created: false,
        escrowId: "esc_" + Math.random().toString(16).slice(2, 10),
        contractHash: "0x" + Math.random().toString(16).slice(2, 10) + "…",
        amount: c.amount,
        arbiterFee: c.arbiterFee,
        swapArbiterFee: c.swapArbiterFee,
        timeoutSeconds: c.timeoutSeconds,
        resolutionSeconds: c.resolutionSeconds,
        defaultFallback: c.defaultFallback,
        timeoutAt: Date.now() + c.timeoutSeconds * 1000,
        resolveBy: null,
        swapped: false,
        status: ContractStatus.ACTIVE,
        claimPool: null,
        locked: 0,
        wallets: { funder: c.amount, recipient: 0, arbiter: 0 },
    };
}

export function isSettled(status: ContractStatusType): boolean {
    return status !== ContractStatus.ACTIVE && status !== ContractStatus.DISPUTED;
}

export function fmtDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m} min` : `${m}m ${s}s`;
}

const secondsLeft = (target: number, now: number) => Math.max(0, Math.ceil((target - now) / 1000));

/** The fee of whichever arbiter is currently active. */
export function activeArbiterFee(state: EscrowState): number {
    return state.swapped ? state.swapArbiterFee : state.arbiterFee;
}

/** True while a Disputed contract can still have its arbiter swapped. */
export function swapAvailable(state: EscrowState): boolean {
    return state.defaultFallback === "SwapArbiter" && !state.swapped;
}

/* ---------------------------------------------------------------------------
   Outcomes and claims
   --------------------------------------------------------------------------- */

export function outcomeStatus(outcome: OutcomeType): ContractStatusType {
    if (outcome === Outcome.RELEASE) return ContractStatus.RELEASED;
    if (outcome === Outcome.REFUND) return ContractStatus.REFUNDED;
    return ContractStatus.SPLIT;
}

/** What the fallback pays out when it actually settles. A used-up swap ends in a Refund. */
function fallbackOutcome(kind: FallbackKind): OutcomeType {
    return kind === "Split" ? Outcome.SPLIT : Outcome.REFUND;
}

/** Mirrors calculate_claims: the fee is carved out of the amount (only when an arbiter decided). */
export function calculateClaims(state: EscrowState, outcome: OutcomeType, includeFee: boolean): ClaimEntry[] {
    const fee = includeFee ? activeArbiterFee(state) : 0;
    const payout = state.amount - fee;
    let claims: ClaimEntry[] = [];
    if (outcome === Outcome.RELEASE) {
        claims = [{ party: "recipient", amount: payout }];
    } else if (outcome === Outcome.REFUND) {
        claims = [{ party: "funder", amount: payout }];
    } else {
        const funderAmount = Math.floor((payout * DEMO_SPLIT.funderBps) / SPLIT_BPS_DENOMINATOR);
        claims = [
            { party: "funder", amount: funderAmount },
            { party: "recipient", amount: payout - funderAmount },
        ];
    }
    if (includeFee) claims.push({ party: "arbiter", amount: fee });
    return claims.filter((c) => c.amount > 0);
}

const claimsText = (claims: ClaimEntry[]) => claims.map((c) => `${c.party} ${c.amount}`).join(" · ");

/* ---------------------------------------------------------------------------
   Actions
   --------------------------------------------------------------------------- */

/** `actor` is whoever submits the transaction. */
export type EscrowAction =
    | { type: "CREATE_CONTRACT"; actor: "funder" }
    | { type: "FUNDER_RELEASE"; actor: Role; signature: Signature }
    | { type: "ENGAGE_ARBITER"; actor: "funder" | "recipient" }
    | { type: "ARBITER_OUTCOME"; actor: Role; outcome: OutcomeType; signature: Signature }
    | { type: "TRIGGER_FALLBACK"; actor: "funder" | "recipient" }
    | { type: "CLAIM_PAYOUT"; actor: Role };

export interface ActionEvaluation {
    valid: boolean;
    /** Teaching explanation of what happened and why. */
    reason: string;
    error?: ErrorCode;
    /** State changes applied when the action is accepted. */
    patch?: Partial<EscrowState>;
    payout?: Payout;
    claims?: ClaimEntry[];
}

function reject(error: ErrorCode, why: string): ActionEvaluation {
    return { valid: false, error, reason: why };
}

function ensureActive(state: EscrowState, disputedWhy: string): ActionEvaluation | null {
    if (state.status === ContractStatus.DISPUTED) return reject("ContractDisputed", disputedWhy);
    if (state.status !== ContractStatus.ACTIVE) {
        return reject(
            "ContractAlreadyResolved",
            `The contract is already ${state.status}. A resolved contract never goes back to Active, so nothing can resolve it a second time — whatever is still owed is collected through claims.`,
        );
    }
    return null;
}

/**
 * The single source of truth for "who can do what, when". Pure: it returns what
 * would happen (and the state patch), applyEvaluation() commits it.
 */
export function evaluateAction(state: EscrowState, action: EscrowAction, now: number = Date.now()): ActionEvaluation {
    if (action.type === "CREATE_CONTRACT") {
        if (state.created) {
            return reject("AlreadyExists", "An escrow_id can only be created once — the module refuses to overwrite an existing contract.");
        }
        const opId = "op_" + Math.random().toString(16).slice(2, 10);
        return {
            valid: true,
            reason: `${state.amount} sats moves from the funder into escrow and the federation returns operation_id=${opId}.`,
            patch: {
                created: true,
                timeoutAt: now + state.timeoutSeconds * 1000,
                locked: state.amount,
                wallets: { ...state.wallets, funder: state.wallets.funder - state.amount },
            },
        };
    }

    if (!state.created) {
        return reject("ContractNotFound", "No contract exists for this escrow_id yet.");
    }

    switch (action.type) {
        case "FUNDER_RELEASE": {
            const blocked = ensureActive(
                state,
                "Once the arbiter has been engaged, the funder can no longer release the funds. Only the arbiter's signed outcome — or, after the deadline, the default fallback — can resolve the contract.",
            );
            if (blocked) return blocked;
            if (action.signature === "forged") {
                return reject(
                    "InvalidSignature",
                    "verify_signature(funder_key, …) fails. The federation checks the signature against the funder_key stored in the contract. A signature from any other key — including the recipient's own — doesn't verify, so the recipient can't release the funds alone.",
                );
            }
            return {
                valid: true,
                reason: `The contract moves Active → Released and pays the full ${state.amount} sats to the recipient in this same transaction. There is no arbiter fee and no claim pool — the arbiter was never involved. Unlike the arbiter's authority, the funder's release isn't time-gated: it works before or after the timeout, right up until a party engages the arbiter after timeout.`,
                patch: {
                    status: ContractStatus.RELEASED,
                    locked: state.locked - state.amount,
                    wallets: { ...state.wallets, recipient: state.wallets.recipient + state.amount },
                },
                payout: { to: "recipient", amount: state.amount },
            };
        }

        case "ENGAGE_ARBITER": {
            const blocked = ensureActive(state, "The arbiter has already been engaged for this contract.");
            if (blocked) return blocked;
            if (now < state.timeoutAt) {
                return reject(
                    "TimeoutNotReached",
                    `The arbiter can only be engaged once now >= timeout, and there are ${secondsLeft(state.timeoutAt, now)}s left. This is the only gate that keeps the arbiter out of a contract: before the timeout nobody can bring them in.`,
                );
            }
            return {
                valid: true,
                reason: `The timeout has passed, the disputant is the funder or the recipient, and their signature over the engage message verifies. The contract moves Active → Disputed { resolve_by: now + ${fmtDuration(state.resolutionSeconds)}, swapped: false }. From now on the funder's release is rejected: only the arbiter's signed outcome — or, once resolve_by passes, the default fallback — can resolve the contract.`,
                patch: {
                    status: ContractStatus.DISPUTED,
                    resolveBy: now + state.resolutionSeconds * 1000,
                },
            };
        }

        case "ARBITER_OUTCOME": {
            if (state.status !== ContractStatus.DISPUTED) {
                if (isSettled(state.status)) {
                    return reject("ContractAlreadyResolved", `The contract is already ${state.status}, so a second outcome has nothing to resolve.`);
                }
                return reject(
                    "ContractNotDisputed",
                    "An arbiter outcome is only accepted for a Disputed contract — one a party has engaged the arbiter for, which requires the timeout to have passed. That's why the arbiter can't act before the timeout even with a perfectly valid signature.",
                );
            }
            if (state.resolveBy !== null && now > state.resolveBy) {
                return reject(
                    "ResolutionDeadlinePassed",
                    "The active arbiter had until resolve_by to decide. After that their signature is no longer accepted — the contract can only be settled by the default fallback.",
                );
            }
            if (action.signature === "stale") {
                return reject(
                    "InvalidSignature",
                    "verify_signature(arbiter_key, …) fails. After the swap, the active arbiter_key is the replacement's. The original arbiter's key no longer has any authority over this contract, so a ruling signed by it doesn't verify — even though it was valid a moment ago.",
                );
            }
            if (action.signature === "forged") {
                return reject(
                    "InvalidSignature",
                    `verify_signature(${state.swapped ? "the replacement arbiter_key" : "arbiter_key"}, …) fails. The message is rebuilt from the declared outcome (${action.outcome}) and the contract, so a signature that wasn't made by the active arbiter — or was made for a different outcome — doesn't verify. Anyone may submit a ruling, but only the arbiter can sign one.`,
                );
            }
            const status = outcomeStatus(action.outcome);
            const claims = calculateClaims(state, action.outcome, true);
            const fee = activeArbiterFee(state);
            return {
                valid: true,
                reason: `verify_signature(${state.swapped ? "the replacement arbiter_key" : "arbiter_key"}, …) passes for hash(federation_id, escrow_id, ${action.outcome}, contract_hash), inside the resolution window. The contract moves Disputed → ${status}. This transaction pays nobody: it writes one claim pool (${claimsText(claims)}) that includes the arbiter's ${fee} sats fee, and the ${state.locked} ecash stays locked until each claimant collects with their own ClaimPayout. Any party in the contract could have submitted this ruling — here the arbiter does.`,
                patch: { status, claimPool: claims },
                claims,
            };
        }

        case "TRIGGER_FALLBACK": {
            if (state.status !== ContractStatus.DISPUTED) {
                return reject("ContractNotDisputed", "The default fallback only exists for a Disputed contract.");
            }
            if (state.resolveBy !== null && now <= state.resolveBy) {
                return reject(
                    "FallbackNotAvailable",
                    state.swapped
                        ? `The replacement arbiter still has until resolve_by to decide (${secondsLeft(state.resolveBy, now)}s left). The swap was already used, so there is no second swap — the fallback only opens once now > resolve_by.`
                        : `The arbiter still has until resolve_by to decide (${secondsLeft(state.resolveBy, now)}s left). The fallback only opens once now > resolve_by.`,
                );
            }

            // SwapArbiter, first use: no payout — replace the arbiter and open a new window.
            if (swapAvailable(state)) {
                return {
                    valid: true,
                    reason: `resolve_by has passed and the first arbiter never ruled. The default fallback is SwapArbiter and the swap hasn't been used yet, so the module pays nobody. It replaces the arbiter: arbiter_key, arbiter_fee_key and the fee (${state.swapArbiterFee} sats) become the swap ones, and the contract stays Disputed { resolve_by: now + ${fmtDuration(state.resolutionSeconds)}, swapped: true }. A ruling signed by the original arbiter now fails with InvalidSignature. A second swap is impossible, which bounds the process.`,
                    patch: {
                        swapped: true,
                        resolveBy: now + state.resolutionSeconds * 1000,
                    },
                };
            }

            const outcome = fallbackOutcome(state.defaultFallback);
            const status = outcomeStatus(outcome);
            const claims = calculateClaims(state, outcome, false);
            const why = state.swapped
                ? `The replacement arbiter missed the deadline too. The swap is already used, so the fallback now settles as a Refund`
                : `resolve_by has passed with no arbiter outcome. The contract settles by its default_fallback (${state.defaultFallback})`;
            return {
                valid: true,
                reason: `${why}: Disputed → ${status}. The federation writes a claim pool with no arbiter fee — the arbiter didn't do the work, so the whole ${state.amount} goes to the parties (${claimsText(claims)}). Nothing is paid until each claimant claims.`,
                patch: { status, claimPool: claims },
                claims,
            };
        }

        case "CLAIM_PAYOUT": {
            const pool = state.claimPool;
            const entry = pool?.find((e) => e.party === action.actor);
            if (!pool || !entry) {
                const why = pool
                    ? `The pool has no entry for the ${action.actor}'s key — they either already claimed, or were never owed anything from this resolution.`
                    : !isSettled(state.status)
                        ? "No resolution has written a claim pool yet — claims only exist after an arbiter outcome or the fallback."
                        : state.resolveBy === null
                            ? "A funder release pays the recipient directly in the same transaction, so there was never anything to claim."
                            : "Every share has already been claimed, so the pool was deleted.";
                return reject("NoPendingClaim", why);
            }
            const remaining = pool.filter((e) => e.party !== action.actor);
            const key = action.actor === "arbiter" ? "arbiter_fee_key" : action.actor === "funder" ? "funder_key" : "recipient_key";
            return {
                valid: true,
                reason: `The pool has an entry for the ${key}: ${entry.amount} sats. The federation pays it to that key and removes the entry${remaining.length === 0 ? "; it was the last one, so the whole pool is deleted" : ""}. Nobody else can claim this share.`,
                patch: {
                    claimPool: remaining.length > 0 ? remaining : null,
                    locked: state.locked - entry.amount,
                    wallets: { ...state.wallets, [action.actor]: state.wallets[action.actor] + entry.amount },
                },
                payout: { to: action.actor, amount: entry.amount, note: "claim" },
            };
        }
    }
}

export function applyEvaluation(state: EscrowState, evaluation: ActionEvaluation): EscrowState {
    return evaluation.valid && evaluation.patch ? { ...state, ...evaluation.patch } : state;
}

/* ---------------------------------------------------------------------------
   Phase — one label for "where are we right now", used by the UI
   --------------------------------------------------------------------------- */

export type Phase = "not-created" | "active-waiting" | "active-open" | "disputed-open" | "disputed-expired" | "claiming" | "done";

export function getPhase(state: EscrowState, now: number): Phase {
    if (!state.created) return "not-created";
    if (state.status === ContractStatus.ACTIVE) return now < state.timeoutAt ? "active-waiting" : "active-open";
    if (state.status === ContractStatus.DISPUTED) {
        return state.resolveBy !== null && now <= state.resolveBy ? "disputed-open" : "disputed-expired";
    }
    return state.claimPool && state.claimPool.length > 0 ? "claiming" : "done";
}

/* ============================================================================
   PACKET MODEL
   Every protocol action becomes a Packet that PARKS at its sender until the
   user approves it, then travels to its destination. Off-chain hand-offs
   (the funder's release signature) are packets too, but the federation is
   never involved, so they have no accept / reject outcome.
   ============================================================================ */

export interface PacketField {
    key: string;
    value: string;
}

export type PacketStatus = "parked" | "in-flight" | "accepted" | "rejected";

export interface PacketDef {
    id: string;
    from: PartyId;
    to: PartyId;
    /** False for an off-chain hand-off between parties. */
    submits: boolean;
    /** What the federation evaluates. Only meaningful when submits is true. */
    action: EscrowAction;
    kind: string;
    title: string;
    fields: PacketField[];
}

export interface PacketInstance extends PacketDef {
    status: PacketStatus;
    result?: {
        valid: boolean;
        reason: string;
        error?: ErrorCode;
        payout?: Payout;
        claims?: ClaimEntry[];
    };
}

const KEY_NAME: Record<Role, string> = { funder: "funder_key", recipient: "recipient_key", arbiter: "arbiter_key" };
const KEY_VALUE: Record<Role, string> = { funder: "bk_a1b2c3…", recipient: "sk_d4e5f6…", arbiter: "ak_9f8e7d…" };
const FEE_KEY_VALUE = "af_5c4b3a…";
const SWAP_ARBITER_KEY = "ak_2b7c10…";
const SWAP_FEE_KEY_VALUE = "af_8d1e44…";

function outcomeText(outcome: OutcomeType): string {
    return outcome === Outcome.SPLIT
        ? `Split { funder_split_bps: ${DEMO_SPLIT.funderBps}, recipient_split_bps: ${DEMO_SPLIT.recipientBps} }`
        : outcome;
}

/** The default_fallback as it appears in the contract. */
function fallbackValue(state: EscrowState): string {
    switch (state.defaultFallback) {
        case "Refund":
            return "Refund — applies if the arbiter never decides";
        case "Split":
            return `Split { funder_split_bps: ${DEMO_SPLIT.funderBps}, recipient_split_bps: ${DEMO_SPLIT.recipientBps} } — applies if the arbiter never decides`;
        case "SwapArbiter":
            return `SwapArbiter { arbiter_key: ${SWAP_ARBITER_KEY}, arbiter_fee_key: ${SWAP_FEE_KEY_VALUE}, arbiter_fee: ${state.swapArbiterFee} sats } — if the first arbiter misses the deadline, a replacement gets one more window`;
    }
}

function creationFields(state: EscrowState): PacketField[] {
    return [
        { key: "funder_key", value: KEY_VALUE.funder },
        { key: "recipient_key", value: KEY_VALUE.recipient },
        { key: "arbiter_key", value: KEY_VALUE.arbiter },
        { key: "arbiter_fee_key", value: FEE_KEY_VALUE },
        { key: "amount", value: `${state.amount} sats` },
        { key: "arbiter_fee", value: `${state.arbiterFee} sats` },
        { key: "timeout", value: `${fmtDuration(state.timeoutSeconds)} from now — until then the arbiter can't be engaged` },
        { key: "resolution_period", value: `${fmtDuration(state.resolutionSeconds)} — the arbiter's time to decide once engaged` },
        { key: "default_fallback", value: fallbackValue(state) },
        { key: "contract_hash", value: "hash(funder_key, recipient_key, arbiter_key, arbiter_fee, amount, timeout, federation_id, resolution_period, default_fallback, arbiter_fee_key)" },
    ];
}

function fieldsForAction(state: EscrowState, action: EscrowAction): PacketField[] {
    const escrowId = { key: "escrow_id", value: state.escrowId };
    switch (action.type) {
        case "CREATE_CONTRACT":
            return creationFields(state);

        case "FUNDER_RELEASE":
            return [
                escrowId,
                { key: "resolution", value: "FunderRelease { funder_signature }" },
                {
                    key: "funder_signature",
                    value:
                        action.signature === "valid"
                            ? "sig_7c2a91… (made by the funder_key, relayed by the funder)"
                            : `<made with the ${KEY_NAME[action.actor]}, not the funder_key>`,
                },
                { key: "message signed", value: "hash(federation_id, escrow_id, Release, contract_hash)" },
                { key: "requires", value: "contract Active — not time-gated" },
            ];

        case "ENGAGE_ARBITER":
            return [
                escrowId,
                { key: "resolution", value: "ArbiterEngaged { disputant_pubkey, disputant_signature }" },
                { key: "disputant_pubkey", value: `${KEY_VALUE[action.actor]} (${KEY_NAME[action.actor]})` },
                { key: "message signed", value: "hash(arbiter_engaged, escrow_id, federation_id, contract_hash)" },
                { key: "requires", value: "contract Active and now >= timeout" },
                { key: "effect", value: `Active → Disputed { resolve_by: now + ${fmtDuration(state.resolutionSeconds)}, swapped: false }` },
            ];

        case "ARBITER_OUTCOME": {
            const submitterKey =
                action.actor === "arbiter"
                    ? `${state.swapped ? SWAP_FEE_KEY_VALUE : FEE_KEY_VALUE} (arbiter_fee_key)`
                    : `${KEY_VALUE[action.actor]} (${KEY_NAME[action.actor]})`;
            const sigValue =
                action.signature === "valid"
                    ? state.swapped
                        ? `sig_c3d2b8… (made by the replacement arbiter_key ${SWAP_ARBITER_KEY})`
                        : "sig_e91fa3… (made by the arbiter_key)"
                    : action.signature === "stale"
                        ? `<made by the original arbiter_key ${KEY_VALUE.arbiter} — replaced by the swap>`
                        : "<does not verify against the active arbiter_key>";
            return [
                escrowId,
                { key: "resolution", value: `ArbiterOutcome { outcome: ${outcomeText(action.outcome)}, arbiter_signature, submitter_pubkey }` },
                { key: "submitter_pubkey", value: submitterKey },
                { key: "arbiter_signature", value: sigValue },
                { key: "message signed", value: `hash(federation_id, escrow_id, ${action.outcome}, contract_hash)` },
                { key: "requires", value: "contract Disputed and now <= resolve_by; any party in the contract may submit" },
                { key: "amount in", value: "0 — the outcome writes a claim pool (fee included) instead of paying" },
            ];
        }

        case "TRIGGER_FALLBACK": {
            const swapping = swapAvailable(state);
            return [
                escrowId,
                {
                    key: "resolution",
                    value: `ResolveFallbackPolicy { claimer_pubkey, fallback: ${state.defaultFallback === "SwapArbiter" ? (state.swapped ? "SwapArbiter (already used)" : "SwapArbiter { … }") : state.defaultFallback
                        } }`,
                },
                { key: "claimer_pubkey", value: `${KEY_VALUE[action.actor]} (${KEY_NAME[action.actor]})` },
                { key: "requires", value: "contract Disputed and now > resolve_by" },
                {
                    key: "effect",
                    value: swapping
                        ? `no payout — arbiter replaced, Disputed { resolve_by: now + ${fmtDuration(state.resolutionSeconds)}, swapped: true }`
                        : `settles as ${fallbackOutcome(state.defaultFallback)} — claim pool without an arbiter fee`,
                },
            ];
        }

        case "CLAIM_PAYOUT": {
            const entry = state.claimPool?.find((e) => e.party === action.actor);
            const feeKey = state.swapped ? SWAP_FEE_KEY_VALUE : FEE_KEY_VALUE;
            return [
                escrowId,
                { key: "resolution", value: "ClaimPayout { claimer_pubkey }" },
                {
                    key: "claimer_pubkey",
                    value: action.actor === "arbiter" ? `${feeKey} (arbiter_fee_key)` : `${KEY_VALUE[action.actor]} (${KEY_NAME[action.actor]})`,
                },
                { key: "requires", value: "an entry for this key in the claim pool" },
                { key: "pays", value: entry ? `${entry.amount} sats` : "— (no entry for this key)" },
            ];
        }
    }
}

function titleForAction(state: EscrowState, action: EscrowAction): string {
    switch (action.type) {
        case "CREATE_CONTRACT":
            return "Create escrow contract";
        case "FUNDER_RELEASE":
            return action.signature === "valid" ? "FunderRelease" : "FunderRelease (forged signature)";
        case "ENGAGE_ARBITER":
            return "ArbiterEngaged";
        case "ARBITER_OUTCOME": {
            const tag = action.signature === "forged" ? " (forged signature)" : action.signature === "stale" ? " (signed by the swapped-out arbiter)" : "";
            return `ArbiterOutcome → ${action.outcome}${tag}`;
        }
        case "TRIGGER_FALLBACK":
            return swapAvailable(state) ? "ResolveFallbackPolicy → SwapArbiter" : "ResolveFallbackPolicy";
        case "CLAIM_PAYOUT": {
            const entry = state.claimPool?.find((e) => e.party === action.actor);
            return entry ? `ClaimPayout · ${entry.amount} sats` : "ClaimPayout";
        }
    }
}

/** A packet that is submitted to the federation by `action.actor`. */
export function packetForAction(id: string, action: EscrowAction, state: EscrowState): PacketDef {
    return {
        id,
        from: action.actor,
        to: "federation",
        submits: true,
        action,
        kind: action.type === "CREATE_CONTRACT" ? "EscrowOutput" : "EscrowInput",
        title: titleForAction(state, action),
        fields: fieldsForAction(state, action),
    };
}

/** Off-chain: the funder hands their release signature to the recipient. */
export function funderRelayPacket(id: string, state: EscrowState): PacketDef {
    return {
        id,
        from: "funder",
        to: "recipient",
        submits: false,
        action: { type: "FUNDER_RELEASE", actor: "recipient", signature: "valid" },
        kind: "funder_signature",
        title: "Signed release, shared off-chain",
        fields: [
            { key: "escrow_id", value: state.escrowId },
            { key: "funder_signature", value: "sig_7c2a91… (over outcome=Release)" },
            { key: "delivered via", value: "out-of-band — not a federation transaction" },
            { key: "next step", value: "the recipient wraps it into FunderRelease and submits it" },
        ],
    };
}

/** The next unclaimed entry of the claim pool, as a ClaimPayout packet. */
export function nextClaimPacket(state: EscrowState): PacketDef | null {
    const entry = state.claimPool?.[0];
    if (!entry) return null;
    return packetForAction(`pk_claim_${entry.party}`, { type: "CLAIM_PAYOUT", actor: entry.party }, state);
}

/* ============================================================================
   GUIDED SCRIPT
     happy path   create → fork → sign (off-chain) → recipient submits → done
     dispute path create → fork → timeout → engage → arbiter decides
                    ├─ ruling:  arbiter submits the signed outcome → claims → done
                    └─ silence: deadline → fallback
                          ├─ Refund / Split:  claims → done
                          └─ SwapArbiter (first time): back to "arbiter decides"
                                with the replacement arbiter
                                (second silence → fallback pays a Refund → claims → done)
   ============================================================================ */

export type StepId =
    | "create"
    | "fork"
    | "happy-sign-relay"
    | "happy-recipient-submits"
    | "wait-timeout"
    | "engage"
    | "dispute-decide"
    | "dispute-submit"
    | "wait-resolution"
    | "fallback"
    | "claims"
    | "done";

export interface ScriptStep {
    id: StepId;
    eyebrow: string;
    title: string;
    body: string;
}

export const SCRIPT_STEPS: Record<StepId, ScriptStep> = {
    create: {
        id: "create",
        eyebrow: "Step 1 — create the contract",
        title: "The funder locks 100 sats in an escrow contract",
        body:
            "Nothing exists yet. The contract names the funder, the recipient, the arbiter and the arbiter's fee key, plus the amount, the arbiter's fee, a timeout, a resolution period and a default fallback. Pick the default fallback — Refund, Split, or SwapArbiter (a replacement arbiter) — inspect the parked packet, then create the contract.",
    },
    fork: {
        id: "fork",
        eyebrow: "Step 2 — who can move the funds?",
        title: "Right now, only the funder can release the funds",
        body:
            "After the recipient delivers, the funder is the only one who can release the locked funds. The recipient has no authority to release them alone, and the arbiter isn't involved: they only come into play if a party engages them after the timeout. What happens next?",
    },
    "happy-sign-relay": {
        id: "happy-sign-relay",
        eyebrow: "Happy path — Step 3",
        title: "The funder signs, and hands the signature to the recipient",
        body:
            "This is not a federation transaction yet — it's an off-chain hand-off. The funder signs a message that says 'release' (the outcome is hardcoded to Release, so there's nothing to tamper with) and sends the signature to the recipient. Approve it to watch it travel.",
    },
    "happy-recipient-submits": {
        id: "happy-recipient-submits",
        eyebrow: "Happy path — Step 4",
        title: "The recipient submits the funder's signature",
        body:
            "Only the recipient can submit the release, since it pays them. The federation verifies the funder's signature, marks the contract Released and pays the recipient the full 100 sats in that same transaction — the escrow's locked balance drops to zero. No arbiter fee and nothing to claim: the arbiter was never involved.",
    },
    "wait-timeout": {
        id: "wait-timeout",
        eyebrow: "Dispute path — Step 3",
        title: "The funder stays silent. Advance the clock.",
        body:
            "The recipient is still waiting. Nothing happens automatically, and the arbiter can't be engaged before the timeout. Fast-forward past it. (The funder's release still works after the timeout — the timeout doesn't revoke it, it only opens the door to the arbiter.)",
    },
    engage: {
        id: "engage",
        eyebrow: "Dispute path — Step 4",
        title: "The recipient engages the arbiter",
        body:
            "After the timeout, either party can engage the arbiter with a signed ArbiterEngaged request. The contract moves to Disputed and a resolution deadline (resolve_by) starts. From now on the funder's release is rejected. Off-chain, the recipient then sends their evidence to the arbiter.",
    },
    "dispute-decide": {
        id: "dispute-decide",
        eyebrow: "Dispute path — Step 5",
        title: "The arbiter decides — or stays silent",
        body:
            "The arbiter reviews the evidence off-chain. If they decide, they sign the outcome (release, refund or split) and submit it to the federation themselves — any party in the contract could submit it, but the arbiter is the natural one. If they stay silent until resolve_by, the contract's default fallback applies instead. What does the arbiter do?",
    },
    "dispute-submit": {
        id: "dispute-submit",
        eyebrow: "Dispute path — Step 6",
        title: "The arbiter submits the signed ruling",
        body:
            "The arbiter builds an ArbiterOutcome resolution around their own signature and submits it before resolve_by. The federation verifies it and settles the contract — but it pays nobody yet: it writes one claim pool for the winning side (both sides, on a split) that also includes the arbiter's fee. The funds stay locked until each claimant collects.",
    },
    "wait-resolution": {
        id: "wait-resolution",
        eyebrow: "Dispute path — Step 6",
        title: "The arbiter never answers. Advance the clock.",
        body:
            "No outcome arrives. Fast-forward past resolve_by. Once it passes, the arbiter's window is closed for good — a late outcome would be rejected — and the default fallback opens.",
    },
    fallback: {
        id: "fallback",
        eyebrow: "Dispute path — Step 7",
        title: "A party triggers the default fallback",
        body:
            "Either party can now submit ResolveFallbackPolicy. The contract settles by its default fallback and writes a claim pool without an arbiter fee: the arbiter didn't do the work, so they aren't paid.",
    },
    claims: {
        id: "claims",
        eyebrow: "Final step — claim the payouts",
        title: "Each claimant collects their own share",
        body:
            "Resolving a dispute only writes the claim pool. Each claimant — the winning party (or both parties on a split) and, if an arbiter ruled, the arbiter for their fee — submits their own ClaimPayout, authorized by the key named in the pool. Nobody can claim someone else's share, and the order doesn't matter. Approve each claim in turn.",
    },
    done: {
        id: "done",
        eyebrow: "Walkthrough complete",
        title: "That's one full path through the protocol",
        body:
            "Start over to take another path — the happy path, the arbiter's ruling (release, refund or split), or a different default fallback (Refund, Split or SwapArbiter) when the arbiter stays silent — or use 'Try to break it' to see what the federation rejects.",
    },
};

/** Step text that depends on the contract's fallback and on whether the arbiter was already swapped. */
export function scriptStep(id: StepId, state: EscrowState): ScriptStep {
    const base = SCRIPT_STEPS[id];
    switch (id) {
        case "dispute-decide":
            if (state.swapped) {
                return {
                    ...base,
                    eyebrow: "After the swap — the replacement arbiter",
                    title: "The replacement arbiter decides — or stays silent",
                    body: `The first arbiter was swapped out. The active arbiter_key, arbiter_fee_key and fee (${state.swapArbiterFee} sats) are now the replacement's, and a fresh resolve_by is running. The replacement signs and submits an outcome — or stays silent, in which case the fallback now refunds with no fee, because a second swap is impossible. What does the replacement arbiter do?`,
                };
            }
            return base;
        case "wait-resolution":
            if (state.swapped) {
                return {
                    ...base,
                    eyebrow: "After the swap — Step 8",
                    title: "The replacement arbiter never answers. Advance the clock.",
                    body: "Fast-forward past the new resolve_by. The replacement's window closes, and there is no second swap: the fallback can only refund now.",
                };
            }
            return base;
        case "fallback":
            if (swapAvailable(state)) {
                return {
                    ...base,
                    title: "A party triggers the fallback — it swaps the arbiter",
                    body: `The contract's default fallback is SwapArbiter. The module sees the swap is still available, so it does not pay anyone: it replaces the arbiter (new arbiter_key, arbiter_fee_key and a ${state.swapArbiterFee} sats fee) and keeps the contract Disputed with a fresh resolve_by and swapped: true.`,
                };
            }
            if (state.swapped) {
                return {
                    ...base,
                    eyebrow: "After the swap — Step 9",
                    title: "A party triggers the fallback — it refunds",
                    body: "The replacement arbiter missed the deadline too. The swap is already used, so ResolveFallbackPolicy now settles as a Refund with no arbiter fee. The funder gets the full amount through the claim pool.",
                };
            }
            if (state.defaultFallback === "Split") {
                return {
                    ...base,
                    body: "Either party can now submit ResolveFallbackPolicy. The contract settles by its default fallback — here, a 50 / 50 Split — and writes a claim pool without an arbiter fee: the arbiter didn't do the work, so they aren't paid.",
                };
            }
            return {
                ...base,
                body: "Either party can now submit ResolveFallbackPolicy. The contract settles by its default fallback — here, Refund — and writes a claim pool without an arbiter fee: the arbiter didn't do the work, so they aren't paid.",
            };
        default:
            return base;
    }
}

export function packetForStep(stepId: StepId, state: EscrowState, ctx: { outcome: OutcomeType | null }): PacketDef | null {
    switch (stepId) {
        case "create":
            return packetForAction("pk_create", { type: "CREATE_CONTRACT", actor: "funder" }, state);
        case "happy-sign-relay":
            return funderRelayPacket("pk_happy-sign-relay", state);
        case "happy-recipient-submits":
            return packetForAction("pk_happy-recipient-submits", { type: "FUNDER_RELEASE", actor: "recipient", signature: "valid" }, state);
        case "engage":
            return packetForAction("pk_engage", { type: "ENGAGE_ARBITER", actor: "recipient" }, state);
        case "dispute-submit":
            // The arbiter signs and submits their own outcome.
            return ctx.outcome
                ? packetForAction("pk_dispute-submit", { type: "ARBITER_OUTCOME", actor: "arbiter", outcome: ctx.outcome, signature: "valid" }, state)
                : null;
        case "fallback":
            return packetForAction("pk_fallback", { type: "TRIGGER_FALLBACK", actor: "funder" }, state);
        default:
            return null;
    }
}

/* ============================================================================
   TRY TO BREAK IT
   Each scenario is a real packet sent at a moment when the federation should
   reject it for one specific reason. A button is only enabled while a dry run
   of evaluateAction gives exactly that rejection (and `requires` holds), so it
   always teaches what it says it teaches.
   ============================================================================ */

export interface BreakScenario {
    id: string;
    label: string;
    /** When the scenario is available — shown under the button. */
    hint: string;
    action: EscrowAction;
    expect: ErrorCode;
    /** Extra availability condition on top of the dry run. */
    requires?: (state: EscrowState) => boolean;
}

export const BREAK_SCENARIOS: BreakScenario[] = [
    {
        id: "forged-release",
        label: "recipient: release with their own signature",
        hint: "While the contract is Active",
        action: { type: "FUNDER_RELEASE", actor: "recipient", signature: "forged" },
        expect: "InvalidSignature",
    },
    {
        id: "engage-early",
        label: "recipient: engage the arbiter early",
        hint: "Before the timeout",
        action: { type: "ENGAGE_ARBITER", actor: "recipient" },
        expect: "TimeoutNotReached",
    },
    {
        id: "decide-early",
        label: "Arbiter outcome before anyone engaged them",
        hint: "While the contract is Active",
        action: { type: "ARBITER_OUTCOME", actor: "arbiter", outcome: Outcome.RELEASE, signature: "valid" },
        expect: "ContractNotDisputed",
    },
    {
        id: "release-after-dispute",
        label: "funder's release after the dispute opened",
        hint: "While the contract is Disputed",
        action: { type: "FUNDER_RELEASE", actor: "recipient", signature: "valid" },
        expect: "ContractDisputed",
    },
    {
        id: "forged-outcome",
        label: "recipient submits a ruling with a forged arbiter signature",
        hint: "While Disputed, before the deadline",
        action: { type: "ARBITER_OUTCOME", actor: "recipient", outcome: Outcome.RELEASE, signature: "forged" },
        expect: "InvalidSignature",
    },
    {
        id: "stale-arbiter",
        label: "Original arbiter rules after being swapped out",
        hint: "After the swap, before the new deadline",
        action: { type: "ARBITER_OUTCOME", actor: "arbiter", outcome: Outcome.RELEASE, signature: "stale" },
        expect: "InvalidSignature",
        requires: (s) => s.swapped,
    },
    {
        id: "fallback-early",
        label: "Trigger the fallback early",
        hint: "While Disputed, before the deadline (also blocks a second swap)",
        action: { type: "TRIGGER_FALLBACK", actor: "recipient" },
        expect: "FallbackNotAvailable",
    },
    {
        id: "decide-late",
        label: "Arbiter outcome after the deadline",
        hint: "After the resolution deadline",
        action: { type: "ARBITER_OUTCOME", actor: "arbiter", outcome: Outcome.RELEASE, signature: "valid" },
        expect: "ResolutionDeadlinePassed",
    },
    {
        id: "release-again",
        label: "Release again after it's resolved",
        hint: "Once the contract is resolved",
        action: { type: "FUNDER_RELEASE", actor: "recipient", signature: "valid" },
        expect: "ContractAlreadyResolved",
    },
    {
        id: "claim-nothing",
        label: "Arbiter: claim a fee that isn't there",
        hint: "When no arbiter fee is claimable",
        action: { type: "CLAIM_PAYOUT", actor: "arbiter" },
        expect: "NoPendingClaim",
    },
];

export function breakScenarioAvailable(scenario: BreakScenario, state: EscrowState, now: number = Date.now()): boolean {
    if (!state.created) return false;
    if (scenario.requires && !scenario.requires(state)) return false;
    return evaluateAction(state, scenario.action, now).error === scenario.expect;
}

/* ============================================================================
   TRUST MODEL CONTENT
   ============================================================================ */

export interface TrustAssumption {
    to: string;
}

export const TRUST_ASSUMPTIONS: TrustAssumption[] = [
    { to: "The funder honestly signs the release once the goods or service have been delivered. Otherwise the recipient has to wait for the timeout and engage the arbiter." },
    { to: "The recipient fulfils the real-world obligation agreed outside the escrow. The protocol can't verify delivery or service completion." },
    { to: "The arbiter makes a fair, evidence-based decision, signs it, and submits it before the resolution deadline. Any party could submit the signed ruling, but if nobody does, the window closes and the fallback applies — without an arbiter fee." },
    { to: "If the contract's fallback is SwapArbiter, the replacement arbiter named at creation is trusted too. The swap happens only once, so a silent arbiter can delay a dispute by one extra window — after that the contract refunds." },
    { to: "The federation's guardians run the module honestly. The escrow rules are enforced by federation consensus, so you inherit the federation's trust assumption — no more." },
];

export const NOT_REQUIRED: string[] = [
    "Real-world identities of funder, recipient, or arbiter",
    "The contents or substance of the dispute",
    "Whether the physical or digital good was actually delivered",
    "Why the arbiter decided the way it did",
];
