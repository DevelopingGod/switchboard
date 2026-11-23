"use client";

import * as React from "react";
import type { AttachmentEstimate, AttachmentInfo } from "@/lib/router-types";
import { tChat } from "@/i18n/chat";

/**
 * Files in the composer (M2.5): each one is uploaded as soon as it is added (paperclip, drop or paste), shown as
 * a chip with progress, and sent with the message by id. The router decides what a file is from its bytes;
 * the checks here only save a pointless upload.
 */

export const MAX_FILES = 5;
export const MAX_MB = 10;
export { ACCEPT } from "@/lib/attach-accept";

export interface PendingFile {
  key: string;
  name: string;
  bytes: number;
  status: "uploading" | "ready" | "error";
  progress: number; // 0..1
  info?: AttachmentInfo;
  error?: string;
  /** A local preview while an image uploads (object URL; revoked on remove). */
  preview?: string;
}

/** A pasted screenshot has no useful name: give it one with the right extension. */
export function nameFor(file: File, i = 0): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `screenshot-${stamp}${i ? `-${i}` : ""}.${ext}`;
}

export { formatBytes } from "@/lib/attachments-format";

function uploadOne(file: File, name: string, onProgress: (p: number) => void): Promise<AttachmentInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/attachments");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let j: { error?: string } & Partial<AttachmentInfo> = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200 && j.id) resolve(j as AttachmentInfo);
      else reject(new Error(j.error ?? tChat("chat.attach.offline", { name })));
    };
    xhr.onerror = () => reject(new Error(tChat("chat.attach.offline", { name })));
    xhr.send(file);
  });
}

export function useAttachments(opts: { estimateFor?: { text: string; target: string; private: boolean } } = {}) {
  const [files, setFiles] = React.useState<PendingFile[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  // The estimate for one set of files (keyed, so a stale one is never shown for a different set).
  const [est, setEst] = React.useState<{ key: string; e: AttachmentEstimate } | null>(null);
  const seq = React.useRef(0);
  const filesRef = React.useRef(files);
  React.useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const patch = (key: string, p: Partial<PendingFile>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));

  const add = React.useCallback((list: File[] | FileList) => {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    setNotice(null);
    const room = MAX_FILES - filesRef.current.length;
    if (incoming.length > room) setNotice(tChat("chat.attach.tooMany", { n: MAX_FILES }));
    incoming.slice(0, Math.max(0, room)).forEach((file, i) => {
      const name = nameFor(file, i);
      const key = `f${++seq.current}`;
      if (file.size > MAX_MB * 1024 * 1024) {
        setFiles((fs) => [...fs, { key, name, bytes: file.size, status: "error", progress: 0, error: tChat("chat.attach.tooBig", { name, mb: MAX_MB }) }]);
        return;
      }
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setFiles((fs) => [...fs, { key, name, bytes: file.size, status: "uploading", progress: 0, preview }]);
      uploadOne(file, name, (p) => patch(key, { progress: p }))
        .then((info) => patch(key, { status: "ready", progress: 1, info, name: info.name }))
        .catch((e: Error) => patch(key, { status: "error", error: e.message }));
    });
  }, []);

  const remove = React.useCallback((key: string) => {
    const f = filesRef.current.find((x) => x.key === key);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    setFiles((fs) => fs.filter((x) => x.key !== key));
    if (f?.info) void fetch(`/api/attachments/${f.info.id}`, { method: "DELETE" }).catch(() => undefined);
  }, []);

  /** After sending: the files now belong to the message (their previews are no longer needed). */
  const clear = React.useCallback(() => {
    for (const f of filesRef.current) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]);
    setNotice(null);
  }, []);

  const ready = files.filter((f) => f.status === "ready" && f.info);
  const uploading = files.some((f) => f.status === "uploading");
  const ids = ready.map((f) => f.info!.id);
  const idKey = ids.join(",");

  const ef = opts.estimateFor;
  const textLen = ef ? Math.round(ef.text.length / 200) : 0; // re-estimate per ~50 tokens of text, not per key
  React.useEffect(() => {
    if (!ef || !idKey) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/attachments/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_ids: idKey.split(","), text: ef.text, target: ef.target, private: ef.private }),
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<AttachmentEstimate>) : null))
        .then((e) => e && setEst({ key: idKey, e }))
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- text length bucket, not every keystroke
  }, [idKey, textLen, ef?.target, ef?.private]);

  const estimate = est && est.key === idKey ? est.e : null;
  return { files, ready, ids, uploading, notice, estimate, add, remove, clear };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** The line under the chips: tokens on the model that would answer, labelled when it is an estimate. */
export function estimateText(e: AttachmentEstimate): string {
  const tokens = e.tokens.toLocaleString();
  if (e.blocked === "no_local_vision") return tChat("chat.attach.privateImage");
  if (e.blocked === "no_model" && e.needs_vision) return tChat("chat.attach.noVision");
  if (!e.model) return tChat("chat.attach.estimateNoModel", { tokens });
  return tChat(e.documented ? "chat.attach.estimate" : "chat.attach.estimateLabelled", { tokens, model: e.model });
}
