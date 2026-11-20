"use client";

/**
 * One job per idle slice (M4b, `/chat` Lighthouse fix). Rendering Markdown and highlighting code for a
 * whole thread at once made one long main-thread task after load (~230 ms of blocking time on a mid-range
 * phone profile); queued, each reply or code block is its own short task, and the page answers input in
 * between. Jobs run in order; a cancelled job is skipped.
 */
type Job = { run: () => void; cancelled: boolean };

const queue: Job[] = [];
let scheduled = false;

const idle = (cb: () => void) =>
  typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(cb, { timeout: 500 }) : window.setTimeout(cb, 16);

function drain() {
  scheduled = false;
  const job = queue.shift();
  if (job && !job.cancelled) job.run();
  if (queue.length) schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  idle(drain);
}

/** Run `fn` in a later idle slice. Returns a cancel function (call it on unmount). */
export function whenIdle(fn: () => void): () => void {
  const job: Job = { run: fn, cancelled: false };
  queue.push(job);
  schedule();
  return () => {
    job.cancelled = true;
  };
}
