import { Fragment, useState, useCallback, useEffect, useRef } from "react";
import type { ReactNode, CSSProperties, MouseEventHandler, Dispatch, SetStateAction } from "react";
import {
    ContractStatus,
    Outcome,
    ERROR_MESSAGES,
    BREAK_SCENARIOS,
    TRUST_ASSUMPTIONS,
    NOT_REQUIRED,
    FALLBACK_OPTIONS,
    createEscrowState,
    evaluateAction,
    applyEvaluation,
    getPhase,
    isSettled,
    swapAvailable,
    scriptStep,
    packetForAction,
    packetForStep,
    nextClaimPacket,
    breakScenarioAvailable,
} from "./domain";
import type {
    EscrowState,
    EscrowAction,
    ContractStatusType,
    ActionEvaluation,
    OutcomeType,
    FallbackKind,
    StepId,
    PacketInstance,
    PacketDef,
    PartyId,
    Phase,
    Role,
} from "./domain";

/** Re-renders every `intervalMs` and returns the current time. */
function useNow(intervalMs: number): number {
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return Date.now();
}

function fmtCountdown(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

type PillTone = "neutral" | "primary" | "success" | "warning" | "danger" | "blue";

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: PillTone }) {
    return <span className={`pill pill--${tone}`}>{children}</span>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
    return <div className="section-label">{children}</div>;
}

export function Card({
    children,
    className = "",
    style,
}: {
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <div className={`card ${className}`.trim()} style={style}>
            {children}
        </div>
    );
}

type ButtonVariant = "default" | "primary" | "danger" | "dark";

export function Button({
    children,
    onClick,
    variant = "default",
    disabled,
    small,
}: {
    children: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
    variant?: ButtonVariant;
    disabled?: boolean;
    small?: boolean;
}) {
    const variantClass = variant !== "default" ? ` btn--${variant}` : "";
    const sizeClass = small ? " btn--small" : "";
    return (
        <button className={`btn${variantClass}${sizeClass}`} onClick={onClick} disabled={disabled}>
            {children}
        </button>
    );
}

export const TABS = [
    { id: "understand", label: "Understand" },
    { id: "playground", label: "Playground" },
    { id: "trust", label: "Trust Model" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export function TopNav({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
    return (
        <div className="top-nav">
            <div className="top-nav__inner">
                <div className="top-nav__brand">
                    <div className="top-nav__logo">⛨</div>
                    <span className="top-nav__name">
                        escrow<span>::</span>playground
                    </span>
                </div>
                <div className="top-nav__tabs">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            className={`top-nav__tab${active === t.id ? " top-nav__tab--active" : ""}`}
                            onClick={() => onChange(t.id)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

export function UnderstandTab({ goTo }: { goTo: (id: TabId) => void }) {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="tab-page">
            <Pill tone="primary">FEDIMINT MODULE · ESCROW</Pill>
            <h1 className="hero-title">
                Trust-minimized escrow
                <br />
                for Fedimint ecash.
            </h1>
            <p className="hero-sub">
                Lock ecash under a programmable agreement between funder, recipient, and arbiter. The federation enforces who can
                release or refund the funds cryptographically, without needing to know anyone's real-world identity, or what the dispute was
                even about.
            </p>
            <div className="hero-ctas">
                <Button variant="primary" onClick={() => goTo("playground")}>
                    Explore the escrow →
                </Button>
                <Button variant="default" onClick={() => goTo("trust")}>
                    Understand the trust model
                </Button>
            </div>

            <div className="expander">
                <button className="expander__toggle" onClick={() => setExpanded((e) => !e)}>
                    What is Fedimint?
                    <span className="expander__icon">{expanded ? "−" : "+"}</span>
                </button>
                {expanded && (
                    <div className="expander__body">
                        <p>
                            Fedimint is a way for a group of operators (a federation) to
                            custody Bitcoin together instead of any single party holding it.
                        </p>
                        <p>
                            Fedimint uses federated consensus across guardians to issue and
                            redeem blind-signed ecash notes.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

/* ============================================================================
   STAGE — parties around the federation, with wallet balances, the escrow's
   locked amount, and a marker for whichever packet is travelling.
   Solid lines are federation transactions, dashed lines are off-chain hand-offs.
   ============================================================================ */

const PARTY_META: Record<PartyId, { label: string; sub: string; colorVar: string; pos: { x: number; y: number } }> = {
    funder: { label: "funder", sub: "funder_key", colorVar: "var(--color-blue)", pos: { x: 14, y: 18 } },
    recipient: { label: "recipient", sub: "recipient_key", colorVar: "var(--color-primary)", pos: { x: 86, y: 18 } },
    arbiter: { label: "Arbiter", sub: "arbiter_key", colorVar: "var(--color-warning)", pos: { x: 50, y: 76 } },
    federation: { label: "Federation", sub: "escrow module", colorVar: "var(--color-dark)", pos: { x: 50, y: 44 } },
};

/** After a SwapArbiter fallback the arbiter node represents the replacement. */
function partyLabel(party: PartyId, swapped: boolean): string {
    return party === "arbiter" && swapped ? "Arbiter #2" : PARTY_META[party].label;
}

function statusTone(status: ContractStatusType): PillTone {
    switch (status) {
        case ContractStatus.RELEASED:
            return "success";
        case ContractStatus.REFUNDED:
            return "blue";
        case ContractStatus.SPLIT:
            return "primary";
        case ContractStatus.DISPUTED:
            return "warning";
        default:
            return "neutral";
    }
}

function StageNode({
    party,
    swapped = false,
    highlighted,
    chips,
}: {
    party: PartyId;
    swapped?: boolean;
    highlighted: boolean;
    chips: ReactNode;
}) {
    const meta = PARTY_META[party];
    const isFederation = party === "federation";
    const isSwappedArbiter = party === "arbiter" && swapped;
    return (
        <div
            className={`stage-node${highlighted ? " stage-node--highlighted" : ""}${isFederation ? " stage-node--federation" : ""}`}
            style={{ left: `${meta.pos.x}%`, top: `${meta.pos.y}%` }}
        >
            <div
                className="stage-node__circle"
                style={{
                    borderColor: meta.colorVar,
                    background: highlighted ? meta.colorVar : isFederation ? "var(--color-dark)" : "#fff",
                    color: highlighted || isFederation ? "#fff" : meta.colorVar,
                }}
            >
                {isFederation ? "⛨" : isSwappedArbiter ? "A2" : meta.label.slice(0, 1)}
            </div>
            <div className="stage-node__label">{partyLabel(party, swapped)}</div>
            <div className="stage-node__sub">{isSwappedArbiter ? "swap arbiter_key" : meta.sub}</div>
            <div className="stage-node__chips">{chips}</div>
        </div>
    );
}

function FlightMarker({ packet }: { packet: PacketInstance }) {
    const tone = !packet.submits
        ? "var(--color-blue)"
        : packet.status === "accepted"
            ? "var(--color-success)"
            : packet.status === "rejected"
                ? "var(--color-danger)"
                : "var(--color-primary)";
    return (
        <div className="flight-marker" style={{ background: tone }} title={packet.title}>
            <span className="flight-marker__kind">{packet.kind}</span>
        </div>
    );
}

function approveLabelFor(packet: PacketInstance): string {
    if (!packet.submits) return "Share off-chain →";
    if (packet.action.type === "CREATE_CONTRACT") return "Create Contract →";
    return "Approve →";
}

/** The parked packet: full-width detail with a clearly separated approve action. */
function DockedPacket({
    packet,
    swapped,
    onInspect,
    onApprove,
}: {
    packet: PacketInstance;
    swapped: boolean;
    onInspect: () => void;
    onApprove?: () => void;
}) {
    return (
        <Card className="docked-packet">
            <div className="docked-packet__route">
                <span className="docked-packet__party">{partyLabel(packet.from, swapped)}</span>
                <span className="docked-packet__arrow">{packet.submits ? "→" : "⇢"}</span>
                <span className="docked-packet__party">{partyLabel(packet.to, swapped)}</span>
                {!packet.submits && <span className="docked-packet__offchain">off-chain</span>}
            </div>
            <button className="docked-packet__body" onClick={onInspect}>
                <span className="docked-packet__kind">{packet.kind}</span>
                <span className="docked-packet__title">{packet.title}</span>
                <span className="docked-packet__hint">Tap to inspect fields →</span>
            </button>
            {onApprove && (
                <Button variant="primary" onClick={onApprove}>
                    {approveLabelFor(packet)}
                </Button>
            )}
        </Card>
    );
}

function PacketInspector({ packet, onClose }: { packet: PacketInstance | null; onClose: () => void }) {
    if (!packet) {
        return (
            <Card className="inspector-empty">
                <span>Click any packet — parked, in flight, or in the log — to inspect its real payload</span>
            </Card>
        );
    }
    const result = packet.result;
    return (
        <Card className="inspector">
            <div className="inspector__head">
                <div>
                    <div className="inspector__kind">{packet.kind}</div>
                    <div className="inspector__title">{packet.title}</div>
                </div>
                <button className="inspector__close" onClick={onClose}>
                    ✕
                </button>
            </div>
            <div className="inspector__fields">
                {packet.fields.map((f) => (
                    <div key={f.key} className="inspector__field">
                        <div className="inspector__field-key">{f.key}</div>
                        <div className="inspector__field-value">{f.value}</div>
                    </div>
                ))}
            </div>
            {result && (
                <div
                    className={`inspector__result ${packet.submits ? (result.valid ? "inspector__result--valid" : "inspector__result--invalid") : "inspector__result--relay"
                        }`}
                >
                    <div className="inspector__result-status">
                        {!packet.submits ? "↳ Delivered off-chain" : result.valid ? "✓ Accepted" : "✕ Rejected"}
                        {result.error && <span className="inspector__error">{result.error}</span>}
                    </div>
                    {result.error && <div className="inspector__error-message">“{ERROR_MESSAGES[result.error]}”</div>}
                    <div className="inspector__result-reason">{result.reason}</div>
                    {result.claims && (
                        <div className="inspector__claims">
                            <div className="inspector__claims-title">Claim pool written — still locked in the federation</div>
                            {result.claims.map((c) => (
                                <div key={c.party} className="inspector__claims-row">
                                    <span>{PARTY_META[c.party].label}</span>
                                    <span>{c.amount} sats</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {result.payout && (
                        <div className="inspector__result-payout">
                            {result.payout.amount} sats → {result.payout.to}
                            {result.payout.note ? ` (${result.payout.note})` : ""}
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}

function lerpPos(from: PartyId, to: PartyId, t: number): { x: number; y: number } {
    const a = PARTY_META[from].pos;
    const b = PARTY_META[to].pos;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function timerPill(state: EscrowState, now: number, phase: Phase): { tone: PillTone; text: string } | null {
    switch (phase) {
        case "active-waiting":
            return { tone: "neutral", text: `⏱ arbiter can be engaged in ${fmtCountdown(state.timeoutAt - now)}` };
        case "active-open":
            return { tone: "warning", text: "⏱ TIMEOUT REACHED — arbiter can be engaged" };
        case "disputed-open":
            return {
                tone: "warning",
                text: `⏱ ${state.swapped ? "replacement arbiter" : "arbiter"} must decide within ${fmtCountdown((state.resolveBy ?? now) - now)}`,
            };
        case "disputed-expired":
            return {
                tone: "danger",
                text: swapAvailable(state) ? "⏱ DEADLINE PASSED — fallback will swap the arbiter" : "⏱ DEADLINE PASSED — fallback is open",
            };
        case "claiming":
            return { tone: "warning", text: "CLAIMS PENDING" };
        default:
            return null;
    }
}

function Stage({
    state,
    now,
    flightPacket,
    flightPhase,
    parkedPacket,
    onApproveParked,
    onInspect,
}: {
    state: EscrowState;
    now: number;
    flightPacket: PacketInstance | null;
    flightPhase: "out" | "back" | null;
    parkedPacket: PacketInstance | null;
    onApproveParked?: () => void;
    onInspect: (p: PacketInstance) => void;
}) {
    const phase = getPhase(state, now);
    const timer = timerPill(state, now, phase);
    const senderParty = parkedPacket?.from ?? flightPacket?.from;
    const activeDestination = parkedPacket?.to ?? flightPacket?.to;
    const claimable = (role: Role) => state.claimPool?.find((c) => c.party === role)?.amount ?? 0;

    const flyingPos = flightPacket
        ? lerpPos(flightPacket.from, flightPacket.to, flightPhase === "back" ? 0.22 : flightPhase === "out" ? 0.82 : 0)
        : null;

    const walletChips = (role: Role) => (
        <>
            <span className="node-chip">{state.wallets[role]} ecash</span>
            {claimable(role) > 0 && <span className="node-chip node-chip--claim">claim: {claimable(role)}</span>}
            {role === "arbiter" && state.swapped && <span className="node-chip node-chip--swap">swapped in</span>}
        </>
    );

    const edge = (a: PartyId, b: PartyId, cls: string) => (
        <line
            key={`${a}-${b}`}
            x1={PARTY_META[a].pos.x}
            y1={PARTY_META[a].pos.y}
            x2={PARTY_META[b].pos.x}
            y2={PARTY_META[b].pos.y}
            className={cls}
        />
    );

    return (
        <Card className="stage">
            {parkedPacket && (
                <DockedPacket
                    packet={parkedPacket}
                    swapped={state.swapped}
                    onInspect={() => onInspect(parkedPacket)}
                    onApprove={onApproveParked}
                />
            )}

            <div className="stage__header">
                {state.created ? (
                    <>
                        <div className="stage__amount">
                            {state.locked > 0 ? "🔒" : "✓"} {state.locked} ecash in escrow
                        </div>
                        <Pill tone={statusTone(state.status)}>{state.status.toUpperCase()}</Pill>
                        {timer && <Pill tone={timer.tone}>{timer.text}</Pill>}
                    </>
                ) : (
                    <Pill tone="neutral">NO CONTRACT YET</Pill>
                )}
            </div>

            <div className="stage__canvas">
                <svg className="stage__edges" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {edge("funder", "federation", "stage__edge")}
                    {edge("recipient", "federation", "stage__edge")}
                    {edge("arbiter", "federation", "stage__edge")}
                    {edge("funder", "recipient", "stage__edge stage__edge--offchain")}
                    {edge("arbiter", "funder", "stage__edge stage__edge--offchain")}
                    {edge("arbiter", "recipient", "stage__edge stage__edge--offchain")}
                    {senderParty && activeDestination && edge(senderParty, activeDestination, "stage__edge stage__edge--active")}
                </svg>

                <StageNode party="funder" highlighted={senderParty === "funder" || activeDestination === "funder"} chips={walletChips("funder")} />
                <StageNode party="recipient" highlighted={senderParty === "recipient" || activeDestination === "recipient"} chips={walletChips("recipient")} />
                <StageNode
                    party="arbiter"
                    swapped={state.swapped}
                    highlighted={senderParty === "arbiter" || activeDestination === "arbiter"}
                    chips={walletChips("arbiter")}
                />
                <StageNode
                    party="federation"
                    highlighted={activeDestination === "federation" && flightPhase === "back"}
                    chips={
                        <span className="node-chip node-chip--locked">{state.created ? `🔒 ${state.locked} locked` : "no contract"}</span>
                    }
                />

                {flightPacket && flyingPos && (
                    <div className="stage__flight-pos" style={{ left: `${flyingPos.x}%`, top: `${flyingPos.y}%` }}>
                        <FlightMarker packet={flightPacket} />
                    </div>
                )}
            </div>

            <div className="stage__legend">
                <span>
                    <i className="legend-line" /> federation transaction
                </span>
                <span>
                    <i className="legend-line legend-line--dashed" /> off-chain hand-off
                </span>
            </div>
        </Card>
    );
}

function PacketLog({ packets, onInspect }: { packets: PacketInstance[]; onInspect: (p: PacketInstance) => void }) {
    return (
        <Card className="event-log">
            <div className="event-log__header">PACKET LOG</div>
            <div className="event-log__body">
                {packets.length === 0 && <div className="event-log__empty">No packets sent yet.</div>}
                {packets
                    .slice()
                    .reverse()
                    .map((p) => {
                        const resultLabel = !p.submits ? "↳ delivered" : p.result?.valid ? "✓ accepted" : `✕ rejected · ${p.result?.error ?? ""}`;
                        const resultClass = !p.submits ? "event-log__result--relay" : p.result?.valid ? "event-log__result--valid" : "event-log__result--invalid";
                        return (
                            <button key={p.id} className="event-log__entry event-log__entry--clickable" onClick={() => onInspect(p)}>
                                <div className="event-log__meta">
                                    <span>{p.from}</span> → <span>{p.to}</span> · {p.kind}
                                </div>
                                <div className="event-log__label">{p.title}</div>
                                <div className={`event-log__result ${resultClass}`}>{resultLabel}</div>
                            </button>
                        );
                    })}
            </div>
        </Card>
    );
}

/* ============================================================================
   PROGRESS PANEL — "where do things stand, and what is true right now"
   ============================================================================ */

function phaseNote(phase: Phase, state: EscrowState): string {
    switch (phase) {
        case "active-waiting":
            return "Only the funder's signature can release the funds. The arbiter can't be engaged until the timeout passes.";
        case "active-open":
            return "The timeout has passed. The funder can still release the funds — but now either party can also engage the arbiter.";
        case "disputed-open":
            return state.swapped
                ? "The arbiter was swapped. The replacement is now the active arbiter and the original's signature is rejected. They must rule before the new resolve_by, otherwise the fallback refunds with no fee."
                : "The arbiter has been engaged. The funder's release is now rejected; the arbiter must decide before resolve_by, and submits their signed outcome themselves.";
        case "disputed-expired":
            if (swapAvailable(state)) {
                return "The arbiter missed the deadline, so their signature is no longer accepted. Either party can now trigger the fallback — SwapArbiter, which pays nobody yet: it brings in a replacement arbiter for one more window.";
            }
            if (state.swapped) {
                return "The replacement arbiter missed the deadline too. There is no second swap, so either party can now trigger the fallback, which refunds with no arbiter fee.";
            }
            return `The arbiter missed the deadline, so their signature is no longer accepted. Either party can now trigger the default fallback (${state.defaultFallback}).`;
        case "claiming":
            return "The contract is settled, but the funds are still locked in the federation. The claim pool names each claimant, and each one collects their own share:";
        case "done":
            return state.resolveBy === null
                ? "Terminal — the funder's release paid the recipient directly, and the escrow_id can never be spent again."
                : "Terminal — everything has been paid out, and the escrow_id can never be spent again.";
        default:
            return "";
    }
}

type TrackTone = "dark" | "warning" | "success" | "blue" | "primary";

function ProgressPanel({ state, now }: { state: EscrowState; now: number }) {
    const phase = getPhase(state, now);
    const resolved = isSettled(state.status);
    const disputed = state.resolveBy !== null;
    const paid = resolved && state.locked === 0;

    const resolvedLabel =
        state.status === ContractStatus.RELEASED ? "Released → recipient" : state.status === ContractStatus.REFUNDED ? "Refunded → funder" : state.status === ContractStatus.SPLIT ? "Split" : "Resolved";
    const resolvedTone: TrackTone = state.status === ContractStatus.RELEASED ? "success" : state.status === ContractStatus.REFUNDED ? "blue" : "primary";

    const nodes: { key: string; label: string; reached: boolean; skipped?: boolean; tone: TrackTone }[] = [
        { key: "locked", label: "Locked", reached: true, tone: "dark" },
        { key: "disputed", label: "Disputed", reached: disputed, skipped: resolved && !disputed, tone: "warning" },
        ...(state.swapped ? [{ key: "swapped", label: "Arbiter swapped", reached: true, tone: "warning" as TrackTone }] : []),
        { key: "resolved", label: resolvedLabel, reached: resolved, tone: resolvedTone },
        { key: "paid", label: "Paid out", reached: paid, tone: "success" },
    ];

    return (
        <Card>
            <SectionLabel>Where things stand</SectionLabel>
            <div className="progress-track">
                {nodes.map((n, i) => (
                    <Fragment key={n.key}>
                        {i > 0 && <div className={`progress-line${n.reached || n.skipped ? " progress-line--active" : ""}`} />}
                        <div
                            className={`progress-step${n.reached ? ` progress-step--reached progress-step--${n.tone}` : ""}${n.skipped ? " progress-step--skipped" : ""}`}
                        >
                            <div className="progress-step__dot" />
                            <div className="progress-step__label">{n.label}</div>
                        </div>
                    </Fragment>
                ))}
            </div>
            <div className="progress-note">{phaseNote(phase, state)}</div>
            {state.claimPool && state.claimPool.length > 0 && (
                <div className="progress-pool">
                    {state.claimPool.map((c) => (
                        <div key={c.party} className="progress-pool__row">
                            <span>{PARTY_META[c.party].label}</span>
                            <span>{c.amount} sats · unclaimed</span>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

/* ============================================================================
   PACKET ENGINE — parks a packet, and on approval animates it out, evaluates it
   with the domain rules, animates the result back, then commits the state change.
   Refs guard against double-approval; nothing with side effects runs inside a
   state updater.
   ============================================================================ */

type FlightPhase = "out" | "back" | null;

function usePacketEngine(state: EscrowState, setState: Dispatch<SetStateAction<EscrowState>>) {
    const [parked, setParkedState] = useState<PacketInstance | null>(null);
    const [flying, setFlying] = useState<PacketInstance | null>(null);
    const [flightPhase, setFlightPhase] = useState<FlightPhase>(null);
    const [log, setLog] = useState<PacketInstance[]>([]);
    const [inspecting, setInspecting] = useState<PacketInstance | null>(null);

    const parkedRef = useRef<PacketInstance | null>(null);
    const busyRef = useRef(false);
    const stateRef = useRef(state);
    stateRef.current = state;
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

    useEffect(
        () => () => {
            timers.current.forEach(clearTimeout);
        },
        [],
    );

    const later = (fn: () => void, ms: number) => {
        timers.current.push(setTimeout(fn, ms));
    };

    const park = useCallback((def: PacketDef) => {
        const packet: PacketInstance = { ...def, status: "parked" };
        parkedRef.current = packet;
        setParkedState(packet);
    }, []);

    const clearParked = useCallback(() => {
        parkedRef.current = null;
        setParkedState(null);
    }, []);

    const approve = useCallback(
        (onSettled?: (accepted: boolean) => void) => {
            const packet = parkedRef.current;
            if (!packet || busyRef.current) return;
            busyRef.current = true;
            parkedRef.current = null;
            setParkedState(null);

            // Mount the marker at the sender first, then move it on a later frame so the
            // CSS transition has a real starting position to animate from.
            setFlying({ ...packet, status: "in-flight" });
            setFlightPhase(null);
            requestAnimationFrame(() => requestAnimationFrame(() => setFlightPhase("out")));

            later(() => {
                const evaluation: ActionEvaluation | null = packet.submits ? evaluateAction(stateRef.current, packet.action, Date.now()) : null;
                const accepted = evaluation ? evaluation.valid : true;
                const result: PacketInstance["result"] = evaluation
                    ? { valid: evaluation.valid, reason: evaluation.reason, error: evaluation.error, payout: evaluation.payout, claims: evaluation.claims }
                    : { valid: true, reason: `Delivered to the ${packet.to}, off-chain — the federation was never involved in this step.` };

                setFlying({ ...packet, status: accepted ? "accepted" : "rejected" });
                setFlightPhase("back");

                later(() => {
                    const settled: PacketInstance = { ...packet, status: accepted ? "accepted" : "rejected", result };
                    if (evaluation) setState((prev) => applyEvaluation(prev, evaluation));
                    setFlying(null);
                    setFlightPhase(null);
                    setLog((l) => [...l, settled]);
                    setInspecting(settled);
                    busyRef.current = false;
                    onSettled?.(accepted);
                }, 650);
            }, 650);
        },
        [setState],
    );

    return { parked, flying, flightPhase, log, inspecting, setInspecting, park, clearParked, approve };
}

/* ============================================================================
   TRY TO BREAK IT — each button is a real packet, enabled only in the phase
   where the federation should reject it for that specific reason.
   ============================================================================ */

function TryToBreakItCard({
    state,
    now,
    busy,
    send,
}: {
    state: EscrowState;
    now: number;
    busy: boolean;
    send: (action: EscrowAction) => void;
}) {
    return (
        <Card className="try-break-card">
            <SectionLabel>Try to break it</SectionLabel>
            <p className="try-break-card__note">
                Each button sends a real packet at a moment when the federation should reject it. Greyed-out buttons unlock in the phase where they apply — the line under each one says when.
            </p>
            <div className="break-grid">
                {BREAK_SCENARIOS.map((s) => (
                    <button
                        key={s.id}
                        className="break-btn"
                        disabled={busy || !breakScenarioAvailable(s, state, now)}
                        onClick={() => send(s.action)}
                    >
                        <span className="break-btn__label">{s.label}</span>
                        <span className="break-btn__hint">{s.hint}</span>
                    </button>
                ))}
            </div>
        </Card>
    );
}

/* ============================================================================
   GUIDED WALKTHROUGH
   create → fork ─┬─ happy:   sign (off-chain) → recipient submits → done
                  └─ dispute: timeout → engage → arbiter decides
                                 ├─ ruling:  arbiter submits signed outcome → claims → done
                                 └─ silence: deadline → fallback
                                       ├─ Refund / Split: claims → done
                                       └─ SwapArbiter: replacement arbiter decides
                                             (silence again → fallback refunds → claims → done)
   ============================================================================ */

function GuidedWalkthrough({
    state,
    setState,
    onRestart,
}: {
    state: EscrowState;
    setState: Dispatch<SetStateAction<EscrowState>>;
    onRestart: () => void;
}) {
    const [stepId, setStepId] = useState<StepId>("create");
    const [disputeOutcome, setDisputeOutcome] = useState<OutcomeType | null>(null);
    const [retry, setRetry] = useState(0);
    const engine = usePacketEngine(state, setState);
    const now = useNow(1000);
    const { park, clearParked } = engine;

    const step = scriptStep(stepId, state);
    const busy = engine.parked != null || engine.flying != null;
    const timeoutPassed = now >= state.timeoutAt;
    const deadlinePassed = state.resolveBy !== null && now > state.resolveBy;

    // Park the packet that belongs to the current step (if it has one).
    useEffect(() => {
        const def = packetForStep(stepId, state, { outcome: disputeOutcome });
        if (def) park(def);
        else clearParked();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stepId, retry]);

    // Claims: park the next unclaimed entry of the pool, one at a time, until it is empty.
    useEffect(() => {
        if (stepId !== "claims" || engine.flying) return;
        if (!state.claimPool || state.claimPool.length === 0) {
            setStepId("done");
            return;
        }
        if (!engine.parked) {
            const def = nextClaimPacket(state);
            if (def) park(def);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stepId, state.claimPool, engine.flying, engine.parked]);

    const handleApprove = () => {
        const parked = engine.parked;
        if (!parked) return;
        if (parked.id.startsWith("pk_break_")) {
            engine.approve();
            return;
        }
        engine.approve((accepted) => {
            if (!accepted && stepId !== "dispute-submit") {
                setRetry((n) => n + 1); // put the same packet back
                return;
            }
            switch (stepId) {
                case "create":
                    setStepId("fork");
                    break;
                case "happy-sign-relay":
                    setStepId("happy-recipient-submits");
                    break;
                case "happy-recipient-submits":
                    setStepId("done");
                    break;
                case "engage":
                    setStepId("dispute-decide");
                    break;
                case "dispute-submit":
                    // If the window closed while the user was reading, the late outcome is rejected
                    // and the fallback is the only way forward.
                    setStepId(accepted ? "claims" : "fallback");
                    break;
                case "fallback": {
                    // `state` here is the state this packet was approved against: if a swap was still
                    // available, the fallback swapped the arbiter instead of settling.
                    if (swapAvailable(state)) {
                        setDisputeOutcome(null);
                        setStepId("dispute-decide");
                    } else {
                        setStepId("claims");
                    }
                    break;
                }
                default:
                    break;
            }
        });
    };

    const fastForwardTimeout = () => setState((prev) => ({ ...prev, timeoutAt: Date.now() - 500 }));
    const fastForwardDeadline = () => setState((prev) => ({ ...prev, resolveBy: Date.now() - 500 }));

    // The arbiter signs the outcome and submits it to the federation themselves.
    const chooseRuling = (outcome: OutcomeType) => {
        setDisputeOutcome(outcome);
        setStepId("dispute-submit");
    };

    const chooseFallback = (kind: FallbackKind) => {
        if (state.created) return;
        setState((prev) => ({ ...prev, defaultFallback: kind }));
        setRetry((n) => n + 1); // re-park the creation packet with the new default_fallback
    };

    const sendBreakIt = (action: EscrowAction) => {
        if (busy) return;
        park(packetForAction(`pk_break_${Date.now()}`, action, state));
    };

    const arbiterName = state.swapped ? "Replacement arbiter" : "Arbiter";

    return (
        <div className="walkthrough">
            <div className="walkthrough__strip">
                <div className="walkthrough__strip-text">
                    <div className="walkthrough-beat__eyebrow">{step.eyebrow}</div>
                    <div className="walkthrough-beat__title">{step.title}</div>
                    <div className="walkthrough-beat__body">{step.body}</div>
                </div>
                <div className="walkthrough__strip-actions">
                    {stepId === "create" &&
                        !state.created &&
                        FALLBACK_OPTIONS.map((o) => (
                            <Button
                                key={o.kind}
                                variant={state.defaultFallback === o.kind ? "dark" : "default"}
                                disabled={engine.flying != null}
                                onClick={() => chooseFallback(o.kind)}
                            >
                                {o.label}
                            </Button>
                        ))}

                    {stepId === "fork" && (
                        <>
                            <Button variant="primary" disabled={busy} onClick={() => setStepId("happy-sign-relay")}>
                                funder signs the release
                            </Button>
                            <Button disabled={busy} onClick={() => setStepId("wait-timeout")}>
                                funder stays silent →
                            </Button>
                        </>
                    )}

                    {stepId === "wait-timeout" &&
                        (timeoutPassed ? (
                            <Button variant="primary" disabled={busy} onClick={() => setStepId("engage")}>
                                Continue →
                            </Button>
                        ) : (
                            <Button variant="primary" disabled={busy} onClick={fastForwardTimeout}>
                                ⏩ Fast-forward past the timeout
                            </Button>
                        ))}

                    {stepId === "dispute-decide" && disputeOutcome === null && (
                        <>
                            <Button variant="primary" disabled={busy} onClick={() => chooseRuling(Outcome.RELEASE)}>
                                Rule for the recipient
                            </Button>
                            <Button disabled={busy} onClick={() => chooseRuling(Outcome.REFUND)}>
                                Rule for the funder
                            </Button>
                            <Button disabled={busy} onClick={() => chooseRuling(Outcome.SPLIT)}>
                                Split 50 / 50
                            </Button>
                            <Button disabled={busy} onClick={() => setStepId("wait-resolution")}>
                                {arbiterName} stays silent →
                            </Button>
                        </>
                    )}

                    {stepId === "wait-resolution" &&
                        (deadlinePassed ? (
                            <Button variant="primary" disabled={busy} onClick={() => setStepId("fallback")}>
                                Continue →
                            </Button>
                        ) : (
                            <Button variant="primary" disabled={busy} onClick={fastForwardDeadline}>
                                ⏩ Fast-forward past the resolution deadline
                            </Button>
                        ))}

                    {stepId === "done" && (
                        <Button variant="primary" onClick={onRestart}>
                            ↺ Start over
                        </Button>
                    )}
                </div>
            </div>

            <div className="playground-grid">
                <div className="playground-col">
                    <Stage
                        state={state}
                        now={now}
                        flightPacket={engine.flying}
                        flightPhase={engine.flightPhase}
                        parkedPacket={engine.parked}
                        onApproveParked={engine.parked ? handleApprove : undefined}
                        onInspect={engine.setInspecting}
                    />
                    {state.created && <ProgressPanel state={state} now={now} />}
                    <TryToBreakItCard state={state} now={now} busy={busy} send={sendBreakIt} />
                </div>

                <div className="playground-col">
                    <PacketInspector packet={engine.inspecting} onClose={() => engine.setInspecting(null)} />
                    <PacketLog packets={engine.log} onInspect={engine.setInspecting} />
                </div>
            </div>
        </div>
    );
}

/* ============================================================================
   PLAYGROUND TAB — nothing exists until the funder's creation packet is approved.
   ============================================================================ */

export function PlaygroundTab() {
    const [state, setState] = useState<EscrowState>(() => createEscrowState());
    const [walkthroughKey, setWalkthroughKey] = useState(0);

    const restart = () => {
        setState(createEscrowState());
        setWalkthroughKey((k) => k + 1);
    };

    return (
        <div className="tab-page tab-page--full">
            <div className="playground-header">
                <h2>Playground</h2>
                <Button small onClick={restart}>
                    ↺ Restart
                </Button>
            </div>
            <GuidedWalkthrough key={walkthroughKey} state={state} setState={setState} onRestart={restart} />
        </div>
    );
}

/* ============================================================================
   TRUST MODEL
   ============================================================================ */

export function TrustTab() {
    return (
        <div className="tab-page tab-page--medium">
            <Pill tone="primary">TRUST MODEL</Pill>
            <h2 className="page-title">What do you actually have to trust?</h2>
            <p className="page-sub">Cryptography removes certain kinds of trust. It doesn't remove every kind of trust.</p>

            <div className="assumptions-section">
                <SectionLabel>Trust assumptions</SectionLabel>
                <div className="assumptions-grid">
                    {TRUST_ASSUMPTIONS.map((a, index) => (
                        <Card key={index}>
                            <div className="assumption-card__body">{a.to}</div>
                        </Card>
                    ))}
                </div>
            </div>

            <Card className="not-required">
                <div className="not-required__title">What the federation doesn't need to know</div>
                <div className="not-required__grid">
                    {NOT_REQUIRED.map((item) => (
                        <div key={item} className="not-required__item">
                            <span>—</span>
                            {item}
                        </div>
                    ))}
                </div>
            </Card>

            <TechnicalArchitecture />
        </div>
    );
}

function TechnicalArchitecture() {
    const [open, setOpen] = useState(false);
    return (
        <div className="tech-arch">
            <button className="expander__toggle" onClick={() => setOpen((o) => !o)}>
                Technical architecture (developer view)
                <span className="expander__icon">{open ? "−" : "+"}</span>
            </button>
            {open && (
                <div className="tech-arch__body">
                    <div className="tech-arch__grid">
                        <div>
                            <div className="tech-arch__label tech-arch__label--off">OFF-CHAIN</div>
                            <ul className="tech-arch__list">
                                <li>Human / business dispute</li>
                                <li>Arbiter's reasoning process</li>
                                <li>Evidence review</li>
                                <li>The funder's release signature handed to the recipient</li>
                            </ul>
                        </div>
                        <div>
                            <div className="tech-arch__label tech-arch__label--enforced">ENFORCED BY THE MODULE</div>
                            <ul className="tech-arch__list">
                                <li>Contract validity (field checks, contract_hash match, escrow_id uniqueness)</li>
                                <li>Signature verification (funder release, engage request, arbiter outcome against the active arbiter key)</li>
                                <li>Arbiter engagement only after the timeout</li>
                                <li>Resolution deadline, then the default fallback (Refund, Split, or a one-time SwapArbiter)</li>
                                <li>SwapArbiter: the first fallback swaps the arbiter, key and fee and opens a new window; the second pays a Refund with no fee</li>
                                <li>State transitions: Active → Disputed → Released / Refunded / Split, exactly once</li>
                                <li>Claim pool: written by an outcome or fallback, includes the arbiter fee, every share claimable once, only by the key named in the pool</li>
                            </ul>
                        </div>
                    </div>
                    <div className="tech-arch__hash-block">
                        contract_hash = hash(funder_key, recipient_key, arbiter_key, arbiter_fee, amount, timeout, federation_id, resolution_period, default_fallback, arbiter_fee_key)
                        <br />
                        resolution message = hash(federation_id, escrow_id, outcome, contract_hash)
                        <br />
                        engage message = hash(arbiter_engaged, escrow_id, federation_id, contract_hash)
                        <br />
                        default_fallback = Refund | Split {"{ funder_split_bps, recipient_split_bps }"} | SwapArbiter {"{ arbiter_key, arbiter_fee_key, arbiter_fee }"}
                    </div>
                </div>
            )}
        </div>
    );
}
