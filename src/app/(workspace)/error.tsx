"use client";

export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="page">
      <h1>Something went wrong</h1>
      <p className="muted">The workspace could not be loaded. Your conversations are not affected.</p>
      <button type="button" className="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
