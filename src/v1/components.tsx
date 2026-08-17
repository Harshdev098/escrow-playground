import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import type { ReactNode, CSSProperties, MouseEventHandler, Dispatch, SetStateAction } from "react";
import {
    ContractStatus,
    Outcome,
    createEscrowState,
    evaluateAction,
    applyAction,
    computeLiveStatus,
    SCRIPT_STEPS,
    creationFields,
    relaySignatureFields,
    arbiterRelayFields,
    buildPacket,
    TRUST_ASSUMPTIONS,
    NOT_REQUIRED,
} from "./domain";
import type {
    EscrowState,
    EscrowAction,
    ContractStatusType,
    CreateEscrowStateConfig,
    ActorStatus,
    StepId,
    PacketInstance,
    PacketDef,
    PartyId,
} from "./domain";

function useNow(intervalMs: number) {
    const [now, setNow] = useState<number>(Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return now;
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
                Escrow without trusting
                <br />
                the escrow.
            </h1>
            <p className="hero-sub">
                Lock ecash under a programmable agreement between buyer, seller, and arbiter. The contract enforces who can
                release or refund the funds — without needing to know anyone's real-world identity, or what the dispute was
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
                            redeem blind-signed ecash notes. A module is a pluggable unit of consensus logic, and this escrow module
                            adds a new transaction type (<code>EscrowOutput</code> / <code>EscrowInput</code>) that the federation
                            validates alongside its normal mint operations, without the federation needing to understand what the
                            escrow is "about."
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

const PARTY_META: Record<PartyId, { label: string; sub: string; colorVar: string; pos: { x: number; y: number } }> = {
    buyer: { label: "Buyer", sub: "buyer_key", colorVar: "var(--color-blue)", pos: { x: 14, y: 22 } },
    seller: { label: "Seller", sub: "seller_key", colorVar: "var(--color-primary)", pos: { x: 86, y: 22 } },
    arbiter: { label: "Arbiter", sub: "arbiter_key", colorVar: "var(--color-warning)", pos: { x: 50, y: 90 } },
    federation: { label: "Federation", sub: "escrow module", colorVar: "var(--color-dark)", pos: { x: 50, y: 50 } },
};

function StageNode({ party, highlighted }: { party: PartyId; highlighted: boolean }) {
    const meta = PARTY_META[party];
    const isFederation = party === "federation";
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
                {isFederation ? "⛨" : meta.label.slice(0, 1)}
            </div>
            <div className="stage-node__label">{meta.label}</div>
            <div className="stage-node__sub">{meta.sub}</div>
        </div>
    );
}

function FlightMarker({ packet }: { packet: PacketInstance; phase: "out" | "back" | null }) {
    const tone =
        packet.status === "accepted" ? "var(--color-success)" : packet.status === "rejected" ? "var(--color-danger)" : "var(--color-primary)";
    return (
        <div className="flight-marker" style={{ background: tone }} title={packet.title}>
            <span className="flight-marker__kind">{packet.kind}</span>
        </div>
    );
}

function DockedPacket({
    packet,
    onInspect,
    onApprove,
    approveLabel,
}: {
    packet: PacketInstance;
    onInspect: () => void;
    onApprove?: () => void;
    approveLabel?: string;
}) {
    return (
        <Card className="docked-packet">
            <div className="docked-packet__route">
                <span className="docked-packet__party">{PARTY_META[packet.from].label}</span>
                <span className="docked-packet__arrow">{packet.submits ? "→" : "⇢"}</span>
                <span className="docked-packet__party">{PARTY_META[packet.to].label}</span>
                {!packet.submits && <span className="docked-packet__offchain">off-chain</span>}
            </div>
            <button className="docked-packet__body" onClick={onInspect}>
                <span className="docked-packet__kind">{packet.kind}</span>
                <span className="docked-packet__title">{packet.title}</span>
                <span className="docked-packet__hint">Tap to inspect fields →</span>
            </button>
            {onApprove && (
                <Button variant="primary" onClick={onApprove}>
                    {approveLabel || "Approve →"}
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
            {packet.result && (
                <div className={`inspector__result ${packet.submits ? (packet.result.valid ? "inspector__result--valid" : "inspector__result--invalid") : "inspector__result--relay"}`}>
                    <div className="inspector__result-status">
                        {!packet.submits ? "↳ Delivered off-chain" : packet.result.valid ? "✓ Accepted" : "✕ Rejected"}
                    </div>
                    <div className="inspector__result-reason">{packet.result.reason}</div>
                    {packet.result.payout && (
                        <div className="inspector__result-payout">
                            {packet.result.payout.amount} ecash → {packet.result.payout.to}
                            {packet.result.payout.note ? ` (${packet.result.payout.note})` : ""}
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

function Stage({
    state,
    now,
    timeoutSeconds,
    flightPacket,
    flightPhase,
    parkedPacket,
    onApproveParked,
    onInspect,
    approveLabel,
    contractExists = true,
}: {
    state: EscrowState;
    now: number;
    timeoutSeconds: number;
    flightPacket: PacketInstance | null;
    flightPhase: "out" | "back" | null;
    parkedPacket: PacketInstance | null;
    onApproveParked?: () => void;
    onInspect: (p: PacketInstance) => void;
    approveLabel?: string;
    contractExists?: boolean;
}) {
    const remaining = Math.max(0, Math.round((state.timeoutAt - now) / 1000));
    const timedOut = now >= state.timeoutAt;
    const statusTone: PillTone =
        state.status === ContractStatus.RELEASED ? "success" : state.status === ContractStatus.REFUNDED ? "blue" : "neutral";

    const senderParty = parkedPacket?.from ?? flightPacket?.from;
    const activeDestination = parkedPacket?.to ?? flightPacket?.to;

    const flyingPos = flightPacket
        ? lerpPos(flightPacket.from, flightPacket.to, flightPhase === "back" ? 0.22 : flightPhase === "out" ? 0.82 : 0)
        : null;

    return (
        <Card className="stage">
            {parkedPacket && (
                <DockedPacket packet={parkedPacket} onInspect={() => onInspect(parkedPacket)} onApprove={onApproveParked} approveLabel={approveLabel} />
            )}

            <div className="stage__header">
                {contractExists ? (
                    <>
                        <div className="stage__amount">
                            {state.status === ContractStatus.ACTIVE ? "🔒" : state.status === ContractStatus.RELEASED ? "→ ✓" : "↩ ✓"} {state.amount} ecash
                        </div>
                        <Pill tone={statusTone}>{state.status.toUpperCase()}</Pill>
                        {state.pendingArbiterFee != null && <Pill tone="warning">FEE PENDING: {state.pendingArbiterFee}</Pill>}
                        {state.status === ContractStatus.ACTIVE && (
                            <Pill tone={timedOut ? "warning" : "neutral"}>{timedOut ? "⏱ TIMEOUT REACHED" : `⏱ ${remaining}s / ${timeoutSeconds}s`}</Pill>
                        )}
                    </>
                ) : (
                    <Pill tone="neutral">NO CONTRACT YET</Pill>
                )}
            </div>

            <div className="stage__canvas">
                <svg className="stage__edges" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1={PARTY_META.buyer.pos.x} y1={PARTY_META.buyer.pos.y} x2={PARTY_META.federation.pos.x} y2={PARTY_META.federation.pos.y} className="stage__edge" />
                    <line x1={PARTY_META.seller.pos.x} y1={PARTY_META.seller.pos.y} x2={PARTY_META.federation.pos.x} y2={PARTY_META.federation.pos.y} className="stage__edge" />
                    <line x1={PARTY_META.arbiter.pos.x} y1={PARTY_META.arbiter.pos.y} x2={PARTY_META.federation.pos.x} y2={PARTY_META.federation.pos.y} className="stage__edge" />
                    <line x1={PARTY_META.buyer.pos.x} y1={PARTY_META.buyer.pos.y} x2={PARTY_META.seller.pos.x} y2={PARTY_META.seller.pos.y} className="stage__edge stage__edge--relay" />
                    {activeDestination && senderParty && (
                        <line
                            x1={PARTY_META[senderParty].pos.x}
                            y1={PARTY_META[senderParty].pos.y}
                            x2={PARTY_META[activeDestination].pos.x}
                            y2={PARTY_META[activeDestination].pos.y}
                            className="stage__edge stage__edge--active"
                        />
                    )}
                </svg>

                <StageNode party="buyer" highlighted={senderParty === "buyer" || activeDestination === "buyer"} />
                <StageNode party="seller" highlighted={senderParty === "seller" || activeDestination === "seller"} />
                <StageNode party="arbiter" highlighted={senderParty === "arbiter" || activeDestination === "arbiter"} />
                <StageNode party="federation" highlighted={activeDestination === "federation" && flightPhase === "back"} />

                {flightPacket && flyingPos && (
                    <div className="stage__flight-pos" style={{ left: `${flyingPos.x}%`, top: `${flyingPos.y}%` }}>
                        <FlightMarker packet={flightPacket} phase={flightPhase} />
                    </div>
                )}
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
                        const resultLabel = !p.submits ? "↳ delivered" : p.result?.valid ? "✓ accepted" : "✕ rejected";
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

function StatusBoard({ statuses }: { statuses: ActorStatus[] }) {
    return (
        <Card className="status-board">
            <SectionLabel>Who can send a packet right now, and why</SectionLabel>
            <div className="status-board__rows">
                {statuses.map((s) => (
                    <div key={s.actor} className={`status-row ${s.live ? "status-row--live" : "status-row--dead"}`}>
                        <div className="status-row__dot" />
                        <div className="status-row__body">
                            <div className="status-row__head">
                                <span className="status-row__actor">{s.label}</span>
                                <span className="status-row__action">{s.actionLabel}</span>
                                <span className={`status-row__badge ${s.live ? "status-row__badge--live" : "status-row__badge--dead"}`}>
                                    {s.live ? "LIVE" : "NOT AVAILABLE"}
                                </span>
                            </div>
                            <div className="status-row__reason">{s.reason}</div>
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    );
}

function StateMachineDiagram({ status, pendingFee }: { status: ContractStatusType; pendingFee: number | null }) {
    const step = status === ContractStatus.ACTIVE ? 0 : 1;
    const outcomeLabel = status === ContractStatus.RELEASED ? "Released → Seller" : status === ContractStatus.REFUNDED ? "Refunded → Buyer" : null;
    const outcomeTone = status === ContractStatus.RELEASED ? "success" : "blue";

    return (
        <Card>
            <SectionLabel>Where things stand</SectionLabel>
            <div className="progress-track">
                <div className={`progress-step${step >= 0 ? " progress-step--active" : ""}`}>
                    <div className="progress-step__dot" />
                    <div className="progress-step__label">Locked</div>
                </div>
                <div className={`progress-line${step >= 1 ? " progress-line--active" : ""}`} />
                <div className={`progress-step${step >= 1 ? ` progress-step--active progress-step--${outcomeTone}` : ""}`}>
                    <div className="progress-step__dot" />
                    <div className="progress-step__label">{outcomeLabel ?? "Resolved"}</div>
                </div>
            </div>
            {status !== ContractStatus.ACTIVE && (
                <div className="progress-note">Terminal — escrow_id is consumed, this contract can never be spent again</div>
            )}
            {pendingFee != null && (
                <div className="progress-fee-note">
                    <Pill tone="warning">Arbiter fee pending: {pendingFee}</Pill>
                    <span>tracked separately from the contract's own status</span>
                </div>
            )}
        </Card>
    );
}

type FlightPhase = "out" | "back" | null;

function usePacketEngine(state: EscrowState, setState: Dispatch<SetStateAction<EscrowState>>) {
    const [parked, setParked] = useState<PacketInstance | null>(null);
    const [flying, setFlying] = useState<PacketInstance | null>(null);
    const [flightPhase, setFlightPhase] = useState<FlightPhase>(null);
    const [log, setLog] = useState<PacketInstance[]>([]);
    const [inspecting, setInspecting] = useState<PacketInstance | null>(null);
    const [flash, setFlash] = useState<PartyId | null>(null);
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

    useEffect(
        () => () => {
            timers.current.forEach(clearTimeout);
        },
        [],
    );

    const park = useCallback((def: PacketDef) => {
        setParked({ ...def, status: "parked" });
    }, []);

    const clearParked = useCallback(() => setParked(null), []);

    const pushLog = useCallback((settled: PacketInstance) => {
        setLog((l) => (l.some((p) => p.id === settled.id) ? l : [...l, settled]));
    }, []);

    const approve = useCallback(
        (onSettled?: (accepted: boolean) => void) => {
            setParked((current) => {
                if (!current) return current;
                const packet = current;
                setFlying({ ...packet, status: "in-flight" });
                setFlightPhase(null);
                setFlash(packet.from);

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => setFlightPhase("out"));
                });

                const t1 = setTimeout(() => {
                    setFlash(null);
                    if (!packet.submits) {
                        setFlightPhase("back");
                        const t2 = setTimeout(() => {
                            const settled: PacketInstance = {
                                ...packet,
                                status: "accepted",
                                result: { valid: true, reason: `Delivered to ${packet.to}, off-chain — the federation was never involved in this step.` },
                            };
                            setFlying(null);
                            setFlightPhase(null);
                            pushLog(settled);
                            setInspecting(settled);
                            onSettled?.(true);
                        }, 650);
                        timers.current.push(t2);
                        return;
                    }

                    if (packet.action.label === "__CREATE__") {
                        const opId = "op_" + Math.random().toString(16).slice(2, 10);
                        const result = {
                            valid: true,
                            reason: `The module independently recomputes contract_hash and checks it against what was submitted, rejects a zero amount, an arbiter_fee >= amount, a timeout already in the past, and any two duplicate keys. All checks pass, so the contract is stored and the federation returns operation_id=${opId} confirming it.`,
                        };
                        setState((prev) => ({ ...prev, timeoutAt: Date.now() + prev.timeoutSeconds * 1000 }));
                        setFlightPhase("back");
                        const t2 = setTimeout(() => {
                            const settled: PacketInstance = { ...packet, status: "accepted", result };
                            setFlying(null);
                            setFlightPhase(null);
                            pushLog(settled);
                            setInspecting(settled);
                            onSettled?.(true);
                        }, 650);
                        timers.current.push(t2);
                        return;
                    }

                    const evalResult = evaluateAction(state, packet.action);
                    const { next, entry } = applyAction(state, packet.action, evalResult, Date.now());
                    setFlightPhase("back");
                    const t2 = setTimeout(() => {
                        const settled: PacketInstance = {
                            ...packet,
                            status: evalResult.valid ? "accepted" : "rejected",
                            result: { valid: evalResult.valid, reason: evalResult.reason, payout: evalResult.payout },
                        };
                        setState({ ...next, events: [...next.events, entry] });
                        setFlying(null);
                        setFlightPhase(null);
                        pushLog(settled);
                        setInspecting(settled);
                        onSettled?.(evalResult.valid);
                    }, 650);
                    timers.current.push(t2);
                }, 650);
                timers.current.push(t1);

                return null;
            });
        },
        [state, setState, pushLog],
    );

    const reset = useCallback(() => {
        setParked(null);
        setFlying(null);
        setFlightPhase(null);
        setLog([]);
        setInspecting(null);
        setFlash(null);
        timers.current.forEach(clearTimeout);
        timers.current = [];
    }, []);

    return { parked, flying, flightPhase, log, inspecting, setInspecting, flash, park, clearParked, approve, reset };
}

function GuidedWalkthrough({
    state,
    setState,
    timeoutSeconds,
}: {
    state: EscrowState;
    setState: Dispatch<SetStateAction<EscrowState>>;
    timeoutSeconds: number;
}) {
    const [stepId, setStepId] = useState<StepId>("create");
    const [created, setCreated] = useState(false);
    const [disputeOutcome, setDisputeOutcome] = useState<typeof Outcome.RELEASE | typeof Outcome.REFUND | null>(null);
    const engine = usePacketEngine(state, setState);
    const now = useNow(1000);

    const step = SCRIPT_STEPS[stepId];

    useEffect(() => {
        if (stepId === "dispute-sign-relay" || stepId === "dispute-winner-submits") return;
        if (step.packet) {
            const def = buildPacket(`pk_${stepId}`, step.packet.from, step.packet.action, step.packet.kind, step.packet.packetTitle, state, {
                to: step.packet.to,
                submits: step.packet.submits,
            });
            if (stepId === "create") {
                // Nothing exists in consensus yet — creation fields are drafted client-side.
                engine.park({ ...def, fields: creationFields({ amount: state.amount, arbiterFee: state.arbiterFee, timeoutSeconds }) });
            } else if (stepId === "happy-sign-relay") {
                // Off-chain hand-off — the raw signature, not yet wrapped in an EscrowInput.
                engine.park({ ...def, fields: relaySignatureFields(state) });
            } else {
                engine.park(def);
            }
        } else {
            engine.clearParked();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stepId]);

    const goNext = (target: StepId) => setStepId(target);

    const handleApproveMain = () => {
        engine.approve(() => {
            if (stepId === "create") {
                setCreated(true);
                goNext("fork");
            } else if (stepId === "happy-sign-relay") goNext("happy-seller-submits");
            else if (stepId === "happy-seller-submits") goNext("done");
            else if (stepId === "dispute-winner-submits") goNext("fee-claim");
            else if (stepId === "fee-claim") goNext("done");
        });
    };

    const handleTimeoutAdvance = () => {
        setState((prev) => ({ ...prev, timeoutAt: Date.now() - 500 }));
        goNext("dispute-sign-relay");
    };

    // Arbiter signs off-chain and the signature is relayed to the winner — no federation
    // submission happens here, mirroring the buyer->seller relay on the happy path.
    const handleDisputeChoice = (outcome: typeof Outcome.RELEASE | typeof Outcome.REFUND) => {
        const winningParty: PartyId = outcome === Outcome.RELEASE ? "seller" : "buyer";
        setDisputeOutcome(outcome);
        const action: EscrowAction = {
            type: "ARBITER_DECISION",
            outcome,
            actor: "arbiter",
            label: `Arbiter decides: ${outcome === Outcome.RELEASE ? "seller wins" : "buyer wins"}`,
            authRequired: "Arbiter signature (post-timeout)",
        };
        const def = buildPacket("pk_dispute-sign-relay", "arbiter", action, "arbiter_signature", `Signed outcome, shared off-chain`, state, {
            to: winningParty,
            submits: false,
        });
        engine.park({ ...def, fields: arbiterRelayFields(state, outcome, winningParty) });
    };

    const handleApproveDisputeRelay = () => {
        engine.approve(() => goNext("dispute-winner-submits"));
    };

    // Once relayed, the winner is the one who submits the ArbiterOutcome resolution.
    useEffect(() => {
        if (stepId !== "dispute-winner-submits" || !disputeOutcome) return;
        const winningParty: PartyId = disputeOutcome === Outcome.RELEASE ? "seller" : "buyer";
        const action: EscrowAction = {
            type: "ARBITER_DECISION",
            outcome: disputeOutcome,
            actor: "arbiter",
            label: `Arbiter decides: ${disputeOutcome === Outcome.RELEASE ? "seller wins" : "buyer wins"}`,
            authRequired: "Arbiter signature (post-timeout)",
        };
        const def = buildPacket("pk_dispute-winner-submits", winningParty, action, "EscrowInput", `ArbiterOutcome → ${disputeOutcome}`, state);
        engine.park(def);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stepId, disputeOutcome]);

    const isBranchPoint = stepId === "fork";
    const isDisputeChoicePending = stepId === "dispute-sign-relay" && !engine.parked;

    const breakItBusy = engine.parked != null || engine.flying != null;
    const terminal = state.status !== ContractStatus.ACTIVE;
    const hasPendingFee = state.pendingArbiterFee != null;
    const sendBreakIt = (action: EscrowAction, from: PartyId, kind: string, title: string) => {
        if (breakItBusy) return;
        const def = buildPacket(`pk_break_${Date.now()}`, from, action, kind, title, state);
        engine.park(def);
    };

    return (
        <div className="walkthrough">
            <div className="walkthrough__strip">
                <div className="walkthrough__strip-text">
                    <div className="walkthrough-beat__eyebrow">{step.eyebrow}</div>
                    <div className="walkthrough-beat__title">{step.title}</div>
                    <div className="walkthrough-beat__body">{step.body}</div>
                </div>
                <div className="walkthrough__strip-actions">
                    {isBranchPoint && (
                        <>
                            <Button variant="primary" onClick={() => goNext("happy-sign-relay")}>
                                Buyer signs now
                            </Button>
                            <Button onClick={handleTimeoutAdvance}>Buyer stays silent →</Button>
                        </>
                    )}

                    {isDisputeChoicePending && (
                        <>
                            <Button variant="primary" onClick={() => handleDisputeChoice(Outcome.RELEASE)}>
                                Rule for seller
                            </Button>
                            <Button onClick={() => handleDisputeChoice(Outcome.REFUND)}>Rule for buyer</Button>
                        </>
                    )}

                </div>
            </div>

            <div className="playground-grid">
                <div className="playground-col">
                    <Stage
                        state={state}
                        now={now}
                        timeoutSeconds={timeoutSeconds}
                        flightPacket={engine.flying}
                        flightPhase={engine.flightPhase}
                        parkedPacket={engine.parked}
                        contractExists={created}
                        onApproveParked={
                            engine.parked
                                ? engine.parked.id.startsWith("pk_break_")
                                    ? () => engine.approve()
                                    : stepId === "dispute-sign-relay"
                                        ? handleApproveDisputeRelay
                                        : handleApproveMain
                                : undefined
                        }
                        approveLabel={stepId === "create" ? "Create Contract →" : "Approve →"}
                        onInspect={engine.setInspecting}
                    />
                    {created && <StateMachineDiagram status={state.status} pendingFee={state.pendingArbiterFee} />}
                    <TryToBreakItCard send={sendBreakIt} terminal={terminal} hasPendingFee={hasPendingFee} busy={breakItBusy} />
                </div>

                <div className="playground-col">
                    <PacketInspector packet={engine.inspecting} onClose={() => engine.setInspecting(null)} />
                    <PacketLog packets={engine.log} onInspect={engine.setInspecting} />
                </div>
            </div>
        </div>
    );
}

function TryToBreakItCard({
    send,
    terminal,
    hasPendingFee,
    busy,
}: {
    send: (action: EscrowAction, from: PartyId, kind: string, title: string) => void;
    terminal: boolean;
    hasPendingFee: boolean;
    busy: boolean;
}) {
    return (
        <Card className="try-break-card">
            <SectionLabel>Try to break it</SectionLabel>
            <p className="try-break-card__note">
                Every button here sends a packet the federation is expected to reject. Approve one in the stage above and read why in the inspector.
            </p>
            <div className="actions-row">
                <Button
                    small
                    variant="danger"
                    disabled={terminal || busy}
                    onClick={() =>
                        send(
                            { type: "SELLER_WITHDRAW_UNAUTHORIZED", actor: "seller", label: "Seller attempts unauthorized withdrawal", authRequired: "Seller signature (insufficient)" },
                            "seller",
                            "EscrowInput",
                            "Unauthorized withdrawal",
                        )
                    }
                >
                    Seller: withdraw directly
                </Button>
                <Button
                    small
                    variant="danger"
                    disabled={terminal || busy}
                    onClick={() =>
                        send(
                            { type: "ARBITER_DECISION_BAD_SIG", actor: "arbiter", label: "Submit outcome with wrong signature", authRequired: "Arbiter signature (invalid)" },
                            "arbiter",
                            "EscrowInput",
                            "ArbiterOutcome (bad signature)",
                        )
                    }
                >
                    Arbiter: wrong signature
                </Button>
                <Button
                    small
                    variant="danger"
                    disabled={!hasPendingFee || busy}
                    onClick={() =>
                        send(
                            { type: "ARBITER_FEE_CLAIM_BAD_SIG", actor: "arbiter", label: "Arbiter claims fee with an invalid signature", authRequired: "Arbiter signature (invalid)" },
                            "arbiter",
                            "EscrowInput",
                            "ArbiterFeeClaim (bad signature)",
                        )
                    }
                >
                    Fee claim: wrong signature
                </Button>
                <Button
                    small
                    variant="danger"
                    disabled={hasPendingFee || busy}
                    onClick={() =>
                        send(
                            { type: "ARBITER_FEE_CLAIM_TOO_EARLY", actor: "arbiter", label: "Arbiter attempts a fee claim with no pending fee", authRequired: "Arbiter signature (no pending fee exists)" },
                            "arbiter",
                            "EscrowInput",
                            "ArbiterFeeClaim (nothing pending)",
                        )
                    }
                >
                    Fee claim: nothing pending
                </Button>
            </div>
        </Card>
    );
}

function SandboxMode({
    state,
    setState,
    timeoutSeconds,
    onRestartWalkthrough,
}: {
    state: EscrowState;
    setState: Dispatch<SetStateAction<EscrowState>>;
    timeoutSeconds: number;
    onRestartWalkthrough: () => void;
}) {
    const engine = usePacketEngine(state, setState);
    const now = useNow(1000);
    const timedOut = now >= state.timeoutAt;
    const terminal = state.status !== ContractStatus.ACTIVE;
    const hasPendingFee = state.pendingArbiterFee != null;
    const statuses = useMemo(() => computeLiveStatus(state, now), [state, now]);
    const busy = engine.parked != null || engine.flying != null;

    const send = (action: EscrowAction, from: PartyId, kind: string, title: string) => {
        if (busy) return;
        const def = buildPacket(`pk_${Date.now()}`, from, action, kind, title, state);
        engine.park(def);
    };

    return (
        <>
            <div className="playground-header">
                <div>
                    <h2>Sandbox</h2>
                    <p>Every button below parks a real packet. Approve it in the stage to send it to the federation and see the result.</p>
                </div>
                <Button small onClick={onRestartWalkthrough}>
                    ↺ Replay walkthrough
                </Button>
            </div>

            <div className="playground-grid">
                <div className="playground-col">
                    <Stage
                        state={state}
                        now={now}
                        timeoutSeconds={timeoutSeconds}
                        flightPacket={engine.flying}
                        flightPhase={engine.flightPhase}
                        parkedPacket={engine.parked}
                        onApproveParked={engine.parked ? () => engine.approve() : undefined}
                        onInspect={engine.setInspecting}
                    />
                    <StateMachineDiagram status={state.status} pendingFee={state.pendingArbiterFee} />

                    <Card>
                        <SectionLabel>Normal actions</SectionLabel>
                        <div className="actions-row">
                            <Button
                                small
                                disabled={terminal || busy}
                                onClick={() =>
                                    send(
                                        { type: "BUYER_RELEASE", actor: "buyer", label: "Buyer signs release to Seller", authRequired: "Buyer signature" },
                                        "buyer",
                                        "EscrowInput",
                                        "BuyerRelease → Seller",
                                    )
                                }
                            >
                                Buyer: sign release
                            </Button>
                            <Button
                                small
                                disabled={terminal || !timedOut || busy}
                                onClick={() =>
                                    send(
                                        { type: "ARBITER_DECISION", outcome: Outcome.RELEASE, actor: "arbiter", label: "Arbiter decides: seller wins", authRequired: "Arbiter signature (post-timeout)" },
                                        "arbiter",
                                        "EscrowInput",
                                        "ArbiterOutcome → Release",
                                    )
                                }
                            >
                                Arbiter: seller wins
                            </Button>
                            <Button
                                small
                                disabled={terminal || !timedOut || busy}
                                onClick={() =>
                                    send(
                                        { type: "ARBITER_DECISION", outcome: Outcome.REFUND, actor: "arbiter", label: "Arbiter decides: buyer wins", authRequired: "Arbiter signature (post-timeout)" },
                                        "arbiter",
                                        "EscrowInput",
                                        "ArbiterOutcome → Refund",
                                    )
                                }
                            >
                                Arbiter: buyer wins
                            </Button>
                            <Button small disabled={terminal || timedOut || busy} onClick={() => setState((prev) => ({ ...prev, timeoutAt: Date.now() - 500 }))}>
                                Force timeout now
                            </Button>
                            <Button
                                small
                                disabled={!hasPendingFee || busy}
                                onClick={() =>
                                    send(
                                        { type: "ARBITER_FEE_CLAIM", actor: "arbiter", label: "Arbiter claims their fee", authRequired: "Arbiter signature (fresh, over ArbiterFeeClaim message)" },
                                        "arbiter",
                                        "EscrowInput",
                                        "ArbiterFeeClaim",
                                    )
                                }
                            >
                                Arbiter: claim fee
                            </Button>
                        </div>
                    </Card>

                    <TryToBreakItCard send={send} terminal={terminal} hasPendingFee={hasPendingFee} busy={busy} />
                </div>

                <div className="playground-col">
                    <StatusBoard statuses={statuses} />
                    <PacketInspector packet={engine.inspecting} onClose={() => engine.setInspecting(null)} />
                    <PacketLog packets={engine.log} onInspect={engine.setInspecting} />
                </div>

            </div>
        </>
    );
}

/* ============================================================================
   PLAYGROUND TAB — root. Nothing is created until the user approves the
   first (creation) packet in the guided walkthrough.
   ============================================================================ */

export function PlaygroundTab() {
    const [amount] = useState<number>(100);
    const [timeoutSeconds] = useState<number>(30);
    const [state, setState] = useState<EscrowState>(() => createEscrowState({ amount: 100, timeoutSeconds: 30 }));
    const [mode, setMode] = useState<"walkthrough" | "sandbox">("walkthrough");
    const [walkthroughKey, setWalkthroughKey] = useState(0);

    const reset = useCallback(
        (cfg: CreateEscrowStateConfig = {}) => {
            setState(createEscrowState({ amount, timeoutSeconds, ...cfg }));
        },
        [amount, timeoutSeconds],
    );

    const restartWalkthrough = () => {
        reset();
        setWalkthroughKey((k) => k + 1);
        setMode("walkthrough");
    };

    return (
        <div className="tab-page tab-page--full">
            {mode === "walkthrough" && (
                <div className="playground-header">
                    <div>
                        <h2>Playground</h2>
                    </div>
                </div>
            )}

            {mode === "walkthrough" ? (
                <GuidedWalkthrough key={walkthroughKey} state={state} setState={setState} timeoutSeconds={timeoutSeconds} />
            ) : (
                <SandboxMode state={state} setState={setState} timeoutSeconds={timeoutSeconds} onRestartWalkthrough={restartWalkthrough} />
            )}
        </div>
    );
}

export function TrustTab() {
    return (
        <div className="tab-page tab-page--medium">
            <Pill tone="primary">TRUST MODEL</Pill>
            <h2 className="page-title">What do you actually have to trust?</h2>
            <p className="page-sub">
                Trust-minimized doesn't mean trust-free. It means the trust required is explicit, narrow, and enforced where
                it can be — and named where it can't.
            </p>


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
                <div className="not-required__title">YOU DO NOT NEED THE MODULE TO KNOW</div>
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
                                <li>Buyer ↔ seller communication</li>
                                <li>Evidence review</li>
                            </ul>
                        </div>
                        <div>
                            <div className="tech-arch__label tech-arch__label--enforced">ENFORCED BY THE MODULE</div>
                            <ul className="tech-arch__list">
                                <li>Contract validity (escrow_id uniqueness, contract_hash match)</li>
                                <li>Signature verification (buyer / arbiter, including the separate fee-claim signature)</li>
                                <li>Timeout gating of arbiter authority</li>
                                <li>State transitions (Active → Released/Refunded)</li>
                                <li>Fund release per contract rules, arbiter fee held pending until claimed</li>
                            </ul>
                        </div>
                    </div>
                    <div className="tech-arch__hash-block">
                        resolution message = hash(federation_id, escrow_id, outcome, contract_hash)
                        <br />
                        contract_hash = hash(buyer_key, seller_key, arbiter_key, amount, timeout, federation_id)
                        <br />
                        fee claim message = hash(escrow_id, fee_amount) — signed and verified independently
                    </div>
                </div>
            )}
        </div>
    );
}

