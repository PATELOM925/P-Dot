"use client";

import { useArranging, useTodayLayout } from "./layout-store";

/** "Arrange" shows the move buttons in each Today section; "Reset layout" puts back the default order and opens every section. */
export function LayoutControls({ userId }: { userId: string }) {
  const [, dispatch] = useTodayLayout(userId);
  const [arranging, setArranging] = useArranging();
  return (
    <div className="layout-controls">
      {arranging && (
        <button type="button" className="button button-small" onClick={() => dispatch({ type: "reset" })}>
          Reset layout
        </button>
      )}
      <button type="button" className="button button-small" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
        Arrange
      </button>
    </div>
  );
}
