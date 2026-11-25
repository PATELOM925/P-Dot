import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";

export const metadata: Metadata = { title: "Controls and evidence · P-Dot" };
export const dynamic = "force-static";

const REPOSITORY = "https://github.com/PATELOM925/P-Dot/blob/44ba3aa023f05d2d76ea2dc1150da13941cf6376/";
const CATALOG = "https://github.com/COHUMAIN-LABS/AGSC-agentic-controls-by-SafeAlignAI/blob/main/COHUMAIN-AGSC-repo/controls/CONTROLS.md";

const controls = [
  {
    id: "ALN-02",
    name: "Human Oversight & Intervention",
    href: `${CATALOG}#aln-02-human-oversight-intervention`,
    status: "Partial",
    evidence: "Ask first puts proposed actions behind a review card. Auto is bounded to up to three task or reminder creations per reply; other action kinds still wait. The Activity trail records action decisions.",
    sources: ["src/lib/approval-policy.ts", "src/features/actions/ApprovalCard.tsx", "src/features/actions/ActionLogList.tsx", "docs/decisions/0011-approval-modes.md"],
    gap: "The selected control also calls for accessible intervene/override/escalate procedures with named responsibilities and triggers, plus a runbook and intervention record. P-Dot has no operator oversight runbook or escalation workflow. The on-device Auto choice is not an operator control.",
  },
  {
    id: "SEC-02",
    name: "Agent Identity & Least-Privilege Authorization",
    href: `${CATALOG}#sec-02-agent-identity-least-privilege-authorization`,
    status: "Partial",
    evidence: "Private routes require a verified session and records are scoped through Supabase RLS. Provider connections are user-owned; Google scopes and MCP tool pins limit which account operations are offered.",
    sources: ["src/server/http/route.ts", "supabase/migrations/20261020000000_memory_documents_actions.sql", "docs/decisions/0014-google-sign-in-and-connection.md", "docs/decisions/0016-mcp-connectors.md"],
    gap: "The catalog asks for a unique non-shared machine identity per agent, just-in-time task-scoped grants, and quarterly entitlement reviews. P-Dot has no agent identity registry, JIT grant/revoke evidence, or entitlement review records.",
  },
  {
    id: "SEC-03",
    name: "Prompt Injection & Adversarial Input Defense",
    href: `${CATALOG}#sec-03-prompt-injection-adversarial-input-defense`,
    status: "Partial",
    evidence: "Retrieved app, document and web text is separated as untrusted input; tool arguments and results are bounded and validated. Safe fake based regression tests cover prompt-injection cases in connector turns.",
    sources: ["src/server/assistant/tools/connectors.ts", "src/server/mcp/results.ts", "src/server/mcp/outbound.ts", "tests/unit/mcp-chat.test.ts"],
    gap: "The catalog additionally requires an input/output firewall across every ingestion boundary, quarterly configuration review, and SIEM injection rules with thresholds and named owners. Those deployed filters, alerts and review records are not evidenced here.",
  },
  {
    id: "SEC-04",
    name: "Observability, Anomaly Detection & Incident Response",
    href: `${CATALOG}#sec-04-observability-anomaly-detection-incident-response`,
    status: "Partial",
    evidence: "The app emits bounded request/provider metadata logs and action history records selected state changes, but does not capture full per-call prompt/tool/decision/token traces.",
    sources: ["src/server/log.ts", "src/server/db/action-log.ts", "docs/PROVIDER-RELIABILITY.md"],
    gap: "No complete per-call trace coverage, agent-trajectory anomaly detection, SOC integration, or AI incident runbook with severities and response SLAs is evidenced. The catalog calls for those items, so basic application logs do not meet this control.",
  },
  {
    id: "SEC-07",
    name: "Memory & Context Lifecycle Security",
    href: `${CATALOG}#sec-07-memory-context-lifecycle-security`,
    status: "Partial",
    evidence: "Memory and context reads are scoped to the signed-in user and mode, memories are visible/editable/deletable, and retrieved content is treated as untrusted. Tests cover user and mode isolation for relevant routes.",
    sources: ["src/server/db/memories.ts", "src/server/assistant/tools/own-data.ts", "src/app/(workspace)/memory/page.tsx", "tests/unit/memories-routes.test.ts", "docs/PRD.md"],
    gap: "The catalog also requires enforced expiry/purge policy and stale or poisoned context detection. There is no memory expiry policy or automated purge; a bounded follow-up assessment is documented below. Context safety has untrusted-data handling, not a complete poisoning-detection system.",
  },
  {
    id: "SAF-02",
    name: "Emergency Stop & Containment (Kill Switch)",
    href: `${CATALOG}#saf-02-emergency-stop-containment-kill-switch`,
    status: "Gap",
    evidence: "A user can disconnect an individual provider account from Connectors; the app attempts that provider's revocation and removes its stored connection when the row still matches.",
    sources: ["src/app/api/connectors/mcp/[server]/disconnect/route.ts", "src/app/api/connectors/google/disconnect/route.ts", "docs/decisions/0014-google-sign-in-and-connection.md", "docs/decisions/0016-mcp-connectors.md"],
    gap: "There is no single authorized system-wide stop that halts application work, revokes credentials and isolates components, no ≤5 second halt SLA, activation role/audit evidence, monthly test or recovery drill. Per-account Disconnect is not a kill switch. A future local pause would stop new P-Dot calls after server observation; it would not revoke provider tokens or cancel in-flight calls.",
  },
];

function SourceLinks({ paths }: { paths: string[] }) {
  return (
    <ul className="plain-list">
      {paths.map((path) => (
        <li key={path}><a href={`${REPOSITORY}${path}`} rel="noopener noreferrer">{path}</a></li>
      ))}
    </ul>
  );
}

export default function ControlsPage() {
  return (
    <LegalPage title="Controls and evidence" updated="25 November 2026">
      <section>
        <h2>Selected-controls evidence map</h2>
        <p>
          This is a partial evidence assessment against six selected controls in the official{" "}
          <a href={CATALOG} rel="noopener noreferrer">COHUMAIN Labs and SafeAlign AI AGSC control catalog</a>.
          Each status compares the catalog&apos;s stated requirements with repository evidence and names material gaps.
          It is not a conformity declaration, certification, independent audit, or confirmation of current production
          configuration. The catalog link is the source for the full and current requirements.
        </p>
        <p className="small muted">Status means: Partial = some requirements have source evidence, with required elements missing; Gap = current evidence does not demonstrate the selected control. A proposed follow-up is not current evidence.</p>
      </section>
      {controls.map((control) => (
        <section key={control.id}>
          <h2><a href={control.href} rel="noopener noreferrer">{control.id}: {control.name}</a></h2>
          <p><strong>Status: {control.status}</strong></p>
          <h3>Current evidence</h3>
          <p>{control.evidence}</p>
          <SourceLinks paths={control.sources} />
          <h3>Requirement gap</h3>
          <p>{control.gap}</p>
        </section>
      ))}
      <section>
        <h2>Proposed bounded work</h2>
        <p>
          Memory expiry and a server-side pause for connected tools are only assessed as possible future slices in{" "}
          <a href="https://github.com/PATELOM925/P-Dot/blob/main/docs/CONTROLS-FOLLOW-UP.md" rel="noopener noreferrer">the follow-up note</a>.
          Neither is a current control. A pause would stop P-Dot from starting new calls after the server observes the
          saved setting; it would not instantly revoke provider tokens or cancel a provider request already in flight.
        </p>
      </section>
    </LegalPage>
  );
}
