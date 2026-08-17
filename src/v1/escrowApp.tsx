import { useState } from "react";
import { TopNav, UnderstandTab, PlaygroundTab, TrustTab } from "./components";
import type { TabId } from "./components";

export default function EscrowApp() {
    const [tab, setTab] = useState<TabId>("understand");

    return (
        <div className="escrow-app">
            <TopNav active={tab} onChange={setTab} />
            {tab === "understand" && <UnderstandTab goTo={setTab} />}
            {tab === "playground" && <PlaygroundTab />}
            {tab === "trust" && <TrustTab />}
        </div>
    );
}
