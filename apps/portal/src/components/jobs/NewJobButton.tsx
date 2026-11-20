"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tJobs } from "@/i18n/jobs";

// The dialog (form, agent order, autonomy dial, preview) is its own chunk: it loads on the first click.
const NewJobDialog = dynamic(() => import("./NewJobDialog"), { ssr: false });

/** "New job" (Jobs board) and "Try a sample job" (empty board): the same dialog as Run as job. */
export function NewJobButton({ prompt, label, variant = "primary" }: { prompt?: string; label?: string; variant?: "primary" | "glass" }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Plus aria-hidden className="size-4" /> {label ?? tJobs("newJob")}
      </Button>
      {open && <NewJobDialog open onOpenChange={setOpen} initialPrompt={prompt} />}
    </>
  );
}
