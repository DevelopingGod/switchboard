"use client";

import * as React from "react";
import type { AttachmentInfo } from "@/lib/router-types";
import { useAttachments } from "@/lib/attachments";
import { ComposerAttachments } from "@/components/chat/ComposerAttachments";

/**
 * M2.5: files added on Home. A lazy chunk (Home ships no attachment code until a file is added): it takes the
 * files Home queued, uploads them, and reports the uploaded ones back so they travel to /chat with the message.
 */
export function HomeAttachments({
  queued,
  onTaken,
  onState,
}: {
  queued: File[];
  onTaken: () => void;
  onState: (s: { ready: AttachmentInfo[]; uploading: boolean }) => void;
}) {
  const att = useAttachments();
  React.useEffect(() => {
    if (!queued.length) return;
    att.add(queued);
    onTaken();
  }, [queued, att, onTaken]);
  const readyKey = att.ids.join(",");
  React.useEffect(() => {
    onState({ ready: att.ready.map((f) => f.info!), uploading: att.uploading });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report when the set of uploaded files changes
  }, [readyKey, att.uploading]);
  return <ComposerAttachments att={att} />;
}
