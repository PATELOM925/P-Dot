"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  approvalIndex,
  isSettled,
  revealedAfterDecision,
  runProgress,
  runStatusLine,
  runTarget,
  stepPhase,
  type ApprovalStatus,
} from "./agent-run";

export type AgentStepState = "done" | "approval" | "next";

export type SupportedTool =
  | "Calendar"
  | "Gmail"
  | "GitHub"
  | "Telegram"
  | "Vercel"
  | "WhatsApp"
  | "Phone"
  | "Search";

export interface AgentStep {
  title: string;
  tool?: SupportedTool;
  detail?: string;
  state: AgentStepState;
  approvalPrompt?: string;
  approvedDetail?: string;
  skippedDetail?: string;
}

export interface UseCase {
  id: string;
  tabLabel: string;
  icon: string;
  category: string;
  task: string;
  badgeWaiting: string;
  badgeApproved: string;
  badgeSkipped: string;
  steps: AgentStep[];
}

export const USE_CASES: readonly UseCase[] = [
  {
    id: "errands",
    tabLabel: "Weekend errands",
    icon: "📅",
    category: "Personal life & booking",
    task: "Get me ready for Friday and book a haircut",
    badgeWaiting: "1 step needs you",
    badgeApproved: "All steps approved ✓",
    badgeSkipped: "Step skipped",
    steps: [
      {
        title: "Understood the goal",
        detail: "Prepare for Friday, book a haircut for Saturday morning.",
        state: "done",
      },
      {
        title: "Checked your calendar",
        tool: "Calendar",
        detail: "Two meetings Friday. Saturday 11:00 is free.",
        state: "done",
      },
      {
        title: "Read your inbox and drafted a reply",
        tool: "Gmail",
        detail: "One email needs an answer. Draft saved, not sent.",
        state: "done",
      },
      {
        title: "Ready to call the salon",
        state: "approval",
        approvalPrompt: "Book Saturday 11:00 by phone. P-Dot only calls after you approve.",
        approvedDetail: "Call confirmed! Appointment reserved for Saturday at 11:00 AM.",
        skippedDetail: "Call skipped. Salon booking was not made.",
      },
      {
        title: "Then send your brief",
        tool: "Telegram",
        detail: "Summary and to-do list to your own chat.",
        state: "next",
      },
    ],
  },
  {
    id: "morning",
    tabLabel: "Morning triage",
    icon: "🌅",
    category: "Daily routine & inbox zero",
    task: "Triage inbox, protect focus time, and organize tasks",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Reply dispatched ✓",
    badgeSkipped: "Draft preserved",
    steps: [
      {
        title: "Scanned 14 unread messages",
        tool: "Gmail",
        detail: "11 newsletters archived, 2 invoices filed, 1 partner proposal flagged.",
        state: "done",
      },
      {
        title: "Defended deep-work blocks",
        tool: "Calendar",
        detail: "3 meetings scheduled. 2-hour morning focus block protected.",
        state: "done",
      },
      {
        title: "Drafted reply to project partner",
        state: "approval",
        approvalPrompt:
          "Send draft reply to Alex: 'Confirming timeline for Q3 release'. P-Dot only sends with your approval.",
        approvedDetail: "Email sent to Alex with agreed timeline and deliverables.",
        skippedDetail: "Draft preserved in Gmail Drafts for your manual review.",
      },
      {
        title: "Synced to-dos to today's list",
        detail: "Added 2 priority action items to your workspace checklist.",
        state: "next",
      },
      {
        title: "Delivered morning voice briefing",
        tool: "Telegram",
        detail: "90-second audio summary delivered directly to your chat.",
        state: "next",
      },
    ],
  },
  {
    id: "travel",
    tabLabel: "Trip booking",
    icon: "✈️",
    category: "Travel & reservations",
    task: "Plan weekend trip to Montreal and reserve travel",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Transit booked ✓",
    badgeSkipped: "Booking skipped",
    steps: [
      {
        title: "Parsed schedule and travel window",
        tool: "Calendar",
        detail: "Depart Friday after 5:00 PM, return Sunday before 9:00 PM.",
        state: "done",
      },
      {
        title: "Researched transit & hotels",
        tool: "Search",
        detail: "Found express train #647 ($79) and 2 top boutique hotels near Old Port.",
        state: "done",
      },
      {
        title: "Built 3-day weekend itinerary",
        detail: "Generated itinerary with restaurants, museums, and $380 budget breakdown.",
        state: "done",
      },
      {
        title: "Confirm train ticket reservation",
        state: "approval",
        approvalPrompt: "Reserve Friday 5:45 PM train ticket ($79) on saved card. Requires your approval.",
        approvedDetail: "Ticket confirmed! Booking reference #MTL-9842 saved to receipts.",
        skippedDetail: "Purchase skipped. Itinerary saved without transit reservation.",
      },
      {
        title: "Sync passes & offline guide",
        tool: "WhatsApp",
        detail: "Sent Apple Wallet tickets and offline guide to WhatsApp.",
        state: "next",
      },
    ],
  },
  {
    id: "devops",
    tabLabel: "Dev & incidents",
    icon: "⚡",
    category: "DevOps & bug triage",
    task: "Triage failing production deployment and deploy hotfix",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Hotfix deployed ✓",
    badgeSkipped: "Deploy paused",
    steps: [
      {
        title: "Detected deployment alert",
        tool: "Vercel",
        detail: "Production build failed on commit #842f (edge API route timeout).",
        state: "done",
      },
      {
        title: "Isolated root cause in git diff",
        tool: "GitHub",
        detail: "Found unhandled async promise timeout in session verification.",
        state: "done",
      },
      {
        title: "Opened hotfix PR with passing test",
        tool: "GitHub",
        detail: "PR #142 opened; test suite and regression checks passed in CI.",
        state: "done",
      },
      {
        title: "Authorize production hotfix deployment",
        state: "approval",
        approvalPrompt: "Merge PR #142 and promote staging build to production. Requires your approval.",
        approvedDetail: "PR #142 merged and redeployed to production. All checks green.",
        skippedDetail: "Deployment paused. PR #142 held for manual engineer review.",
      },
      {
        title: "Broadcast incident resolution",
        tool: "Telegram",
        detail: "Posted post-mortem timeline and changelog link to #engineering.",
        state: "next",
      },
    ],
  },
  {
    id: "meeting",
    tabLabel: "Meeting prep",
    icon: "📊",
    category: "Work & meetings",
    task: "Prepare executive brief for 2:00 PM product review",
    badgeWaiting: "1 step needs you",
    badgeApproved: "Brief sent ✓",
    badgeSkipped: "Brief saved locally",
    steps: [
      {
        title: "Reviewed invite & attendees",
        tool: "Calendar",
        detail: "Quarterly review with Product Director and 3 department leads.",
        state: "done",
      },
      {
        title: "Pulled weekly progress & shipped features",
        tool: "GitHub",
        detail: "3 key epics delivered, 12 PRs merged, zero blocking issues.",
        state: "done",
      },
      {
        title: "Synthesized open stakeholder feedback",
        tool: "Gmail",
        detail: "Extracted 2 unresolved feedback items from yesterday's thread.",
        state: "done",
      },
      {
        title: "Distribute pre-read executive summary",
        state: "approval",
        approvalPrompt: "Send 1-page executive summary to the 4 attendees 30 minutes before call.",
        approvedDetail: "Executive brief sent to all attendees with meeting agenda highlights.",
        skippedDetail: "Pre-read was not sent. Saved locally to your private workspace.",
      },
      {
        title: "Deliver talking points before call",
        tool: "Telegram",
        detail: "Push key talking points to your smartwatch 5 minutes before call.",
        state: "next",
      },
    ],
  },
] as const;

const STEP_MS = 950;
/** How long the old scenario takes to fade out before the new one fades in. */
const FADE_MS = 260;
/** Matches the wrapper's 0.375rem padding in the stylesheet (6px on each side). */
const PANEL_PADDING_PX = 6;
const FIRST_STEP_MS = 600;
/** The demo approves the waiting step after this short pause, so every run is shown to the end by default. */
const AUTO_APPROVE_MS = 1800;
/** After a run has fully finished, the card waits this long, then moves to the next scenario. */
const ADVANCE_AFTER_MS = 3200;

const subscribeReducedMotion = (onChange: () => void) => {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const readReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
}

interface AgentRunProps {
  useCase: UseCase;
  reducedMotion: boolean;
  /** The visitor is hovering or focused on the card: nothing happens on its own. */
  paused: boolean;
  onAdvance: () => void;
}

/**
 * One simulated run: steps appear one by one, the run pauses at the step that
 * needs the user, and carries on after Approve or Skip. Mount it with a new key
 * to start over. Nothing here talks to a server; it is only an illustration.
 */
function AgentRun({ useCase, reducedMotion, paused, onAdvance }: AgentRunProps) {
  const { steps } = useCase;
  const [status, setStatus] = useState<ApprovalStatus>("waiting");
  const [revealed, setRevealed] = useState(0);
  const [decidedBy, setDecidedBy] = useState<"you" | "demo">("you");

  // With reduced motion there is no animation: the run is shown at its stopping point at once.
  const shown = reducedMotion ? runTarget(steps, status) : revealed;
  const settled = isSettled(steps, shown, status);

  useEffect(() => {
    if (reducedMotion || settled) return;
    const timer = setTimeout(() => setRevealed((count) => count + 1), shown === 0 ? FIRST_STEP_MS : STEP_MS);
    return () => clearTimeout(timer);
  }, [reducedMotion, settled, shown]);

  const finished = settled && status !== "waiting";

  // By default the demo plays the part of the user and approves the waiting step, so nobody has to
  // click to see how a finished run looks. The visitor can still choose Approve or Skip first, or switch afterwards.
  useEffect(() => {
    if (!settled || status !== "waiting") return;
    const timer = setTimeout(() => {
      setDecidedBy("demo");
      setStatus("approved");
      setRevealed((count) => revealedAfterDecision(steps, Math.max(count, shown)));
    }, AUTO_APPROVE_MS);
    return () => clearTimeout(timer);
  }, [settled, status, steps, shown]);

  // The tab moves on only after every step has finished (including the ones after the approval).
  useEffect(() => {
    if (!finished || paused) return;
    const timer = setTimeout(onAdvance, ADVANCE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [finished, paused, onAdvance]);

  const decide = (next: ApprovalStatus) => {
    setDecidedBy("you");
    setStatus(next);
    setRevealed((count) => revealedAfterDecision(steps, Math.max(count, shown)));
  };

  /** Show the other outcome: the steps after the approval step run again from there. */
  const switchOutcome = (next: ApprovalStatus) => {
    setDecidedBy("you");
    setStatus(next);
    setRevealed(revealedAfterDecision(steps, approvalIndex(steps)));
  };

  const progress = runProgress(steps, shown);

  return (
    <>
      <div className="agent-card-head">
        <div>
          <p className="small muted agent-label">
            Task <span className="agent-category-tag">• {useCase.category}</span>
          </p>
          <p className="agent-task">{useCase.task}</p>
        </div>
        {!settled ? (
          <span key="working" className="chip chip-working agent-badge">
            Working…
          </span>
        ) : status === "waiting" ? (
          <span key="waiting" className="chip chip-warning agent-badge">
            {useCase.badgeWaiting}
          </span>
        ) : status === "approved" ? (
          <span key="approved" className="chip chip-success agent-badge">
            {useCase.badgeApproved}
          </span>
        ) : (
          <span key="skipped" className="chip chip-neutral agent-badge">
            {useCase.badgeSkipped}
          </span>
        )}
      </div>

      <div className="agent-progress">
        <div
          className="agent-progress-bar"
          role="progressbar"
          aria-label="Simulated run progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ width: `${progress * 100}%` }} />
        </div>
        <p className="small muted agent-status-line" role="status">
          {runStatusLine(steps, shown, status)}
        </p>
      </div>

      <ol className="agent-steps">
        {steps.map((step, index) => {
          const phase = stepPhase(steps, index, shown, status);
          const isApprovalStep = step.state === "approval";
          const bulletClass =
            phase === "done" || phase === "approved"
              ? "agent-bullet agent-bullet-done"
              : phase === "skipped"
                ? "agent-bullet agent-bullet-skipped"
                : phase === "approval"
                  ? "agent-bullet agent-bullet-approval"
                  : phase === "working"
                    ? "agent-bullet agent-bullet-working"
                    : "agent-bullet agent-bullet-queued";

          return (
            <li key={step.title} className={`agent-step agent-step-${phase}`}>
              <span className={bulletClass} aria-hidden="true">
                {phase === "approved" || phase === "done" ? "✓" : index + 1}
              </span>

              <div className="agent-step-body">
                <p className="agent-step-title">{step.title}</p>

                {phase === "working" && (
                  <p className="agent-step-detail agent-working">
                    {step.tool && <span className={`chip chip-${step.tool.toLowerCase()}`}>{step.tool}</span>}
                    <span className="agent-dots" aria-label="Working">
                      <i />
                      <i />
                      <i />
                    </span>
                  </p>
                )}

                {phase === "done" && step.detail && (
                  <p className="agent-step-detail">
                    {step.tool && <span className={`chip chip-${step.tool.toLowerCase()}`}>{step.tool}</span>} {step.detail}
                  </p>
                )}

                {!isApprovalStep && phase === "queued" && step.tool && (
                  <p className="agent-step-detail">
                    <span className={`chip chip-${step.tool.toLowerCase()} chip-queued`}>{step.tool}</span>
                  </p>
                )}

                {isApprovalStep && phase === "approval" && (
                  <div className="agent-approval">
                    <p className="small">{step.approvalPrompt}</p>
                    <div className="actions">
                      <button type="button" className="button button-primary button-small" onClick={() => decide("approved")}>
                        Approve
                      </button>
                      <button type="button" className="button button-small" onClick={() => decide("skipped")}>
                        Skip
                      </button>
                    </div>
                  </div>
                )}

                {isApprovalStep && phase === "approved" && (
                  <div className="agent-approval agent-approval-confirmed">
                    <div className="agent-approval-header">
                      <span>{decidedBy === "you" ? "✓ Approved by you" : "✓ Approved (demo)"}</span>
                      {finished && (
                        <button type="button" className="agent-switch-btn" onClick={() => switchOutcome("skipped")}>
                          See it skipped instead
                        </button>
                      )}
                    </div>
                    <p className="small">{step.approvedDetail}</p>
                  </div>
                )}

                {isApprovalStep && phase === "skipped" && (
                  <div className="agent-approval agent-approval-skipped">
                    <div className="agent-approval-header">
                      <span>Skipped by you</span>
                      {finished && (
                        <button type="button" className="agent-switch-btn" onClick={() => switchOutcome("approved")}>
                          See it approved instead
                        </button>
                      )}
                    </div>
                    <p className="small">{step.skippedDetail}</p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function DynamicAgentCard() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The scenario on screen. It follows the selected tab after the old one has faded out.
  const [shownIndex, setShownIndex] = useState(0);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const fallbackCase: UseCase = USE_CASES[0] as UseCase;
  const currentCase: UseCase = USE_CASES[shownIndex] ?? fallbackCase;
  const leaving = shownIndex !== selectedIndex;
  const innerRef = useRef<HTMLDivElement>(null);

  // Fade the old scenario out, swap, and fade the new one in.
  useEffect(() => {
    if (shownIndex === selectedIndex) return;
    const timer = setTimeout(() => setShownIndex(selectedIndex), reducedMotion ? 0 : FADE_MS);
    return () => clearTimeout(timer);
  }, [selectedIndex, shownIndex, reducedMotion]);

  // Let the card grow and shrink smoothly when the content changes height.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPanelHeight(Math.ceil(entry.contentRect.height));
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const nextUseCase = useCallback(() => {
    setSelectedIndex((prev) => (prev + 1) % USE_CASES.length);
  }, []);

  const prevUseCase = useCallback(() => {
    setSelectedIndex((prev) => (prev - 1 + USE_CASES.length) % USE_CASES.length);
  }, []);

  const select = (index: number) => {
    setSelectedIndex(index);
  };

  // Centre the selected tab in the scrolling tab row, so it is fully visible and clear of the soft
  // fade at both edges (the browser stops at the ends, so the first and last tabs sit against them).
  useEffect(() => {
    const list = tabsRef.current;
    if (!list) return;
    const reveal = (smooth: boolean) => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      const left = tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2;
      list.scrollTo({ left: Math.max(0, left), behavior: smooth && !reducedMotion ? "smooth" : "auto" });
    };
    reveal(true);
    // A narrower window or a late font can move the tab, so centre it again then, without animation.
    const onResize = () => reveal(false);
    window.addEventListener("resize", onResize);
    void document.fonts?.ready.then(() => reveal(false));
    return () => window.removeEventListener("resize", onResize);
  }, [selectedIndex, reducedMotion]);

  const onTabKeyDown = (event: React.KeyboardEvent) => {
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const last = USE_CASES.length - 1;
    const next =
      key === "Home" ? 0 : key === "End" ? last : key === "ArrowRight" ? (selectedIndex + 1) % USE_CASES.length : (selectedIndex - 1 + USE_CASES.length) % USE_CASES.length;
    select(next);
    requestAnimationFrame(() => document.getElementById(`agent-tab-${USE_CASES[next]?.id}`)?.focus());
  };

  return (
    <section
      ref={containerRef}
      className="agent-card"
      aria-label="Example of personal bot agent runs"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
    >
      <div className="agent-card-nav">
        <div className="agent-tabs-wrap">
          <div className="agent-tabs" role="tablist" aria-label="Personal bot use cases" ref={tabsRef} onKeyDown={onTabKeyDown}>
            {USE_CASES.map((useCase, idx) => {
              const isActive = idx === selectedIndex;
              return (
                <button
                  key={useCase.id}
                  type="button"
                  role="tab"
                  id={`agent-tab-${useCase.id}`}
                  aria-selected={isActive}
                  aria-controls={`agent-panel-${useCase.id}`}
                  tabIndex={isActive ? 0 : -1}
                  className={`agent-tab${isActive ? " is-active" : ""}`}
                  onClick={() => select(idx)}
                >
                  <span className="agent-tab-icon" aria-hidden="true">
                    {useCase.icon}
                  </span>
                  <span>{useCase.tabLabel}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="agent-nav-controls" aria-label="Use case carousel controls">
          <button
            type="button"
            className="agent-nav-btn"
            onClick={() => {
              prevUseCase();
            }}
            aria-label="Previous scenario"
            title="Previous scenario"
          >
            ‹
          </button>
          <button
            type="button"
            className="agent-nav-btn"
            onClick={() => {
              nextUseCase();
            }}
            aria-label="Next scenario"
            title="Next scenario"
          >
            ›
          </button>
        </div>
      </div>

      <div className="agent-panel-wrap" style={panelHeight === null ? undefined : { height: panelHeight + PANEL_PADDING_PX * 2 }}>
        <div
          ref={innerRef}
          id={`agent-panel-${currentCase.id}`}
          role="tabpanel"
          aria-labelledby={`agent-tab-${currentCase.id}`}
          className={`agent-card-panel${leaving ? " is-leaving" : ""}`}
        >
          <AgentRun
            key={currentCase.id}
            useCase={currentCase}
            reducedMotion={reducedMotion}
            paused={isPaused || leaving}
            onAdvance={nextUseCase}
          />
        </div>
      </div>

      <div className="agent-foot">
        <p className="small muted">
          Illustrative example. Today P-Dot can read Gmail, Calendar, Notion, Linear and Todoist when you ask. Phone
          calls, Telegram and scheduled routines are not available yet. P-Dot asks before each action, and AI can make
          mistakes.
        </p>
      </div>
    </section>
  );
}
