import { useCallback, useSyncExternalStore } from "react";
import { getPublicationStatus, type PublicationStatus } from "./api";

type Snapshot = { status?: PublicationStatus; error?: string };
type Entry = { snapshot: Snapshot; listeners: Set<() => void>; pending?: Promise<PublicationStatus | undefined>; timer?: ReturnType<typeof setTimeout>; updated: number; posting: boolean; focus?: () => void };
const entries = new Map<string, Entry>();
const empty: Snapshot = {};
function entryFor(id: string) {
  let entry = entries.get(id);
  if (!entry) { entry = { snapshot: {}, listeners: new Set(), updated: 0, posting: false }; entries.set(id, entry); }
  return entry;
}
function notify(entry: Entry) { entry.listeners.forEach(listener => listener()); }
function schedule(id: string, entry: Entry) {
  clearTimeout(entry.timer);
  if (!entry.listeners.size) return;
  entry.timer = setTimeout(() => void refreshPublication(id), entry.posting || entry.snapshot.status?.inProgress ? 750 : 15000);
}
export function refreshPublication(id: string, force = true): Promise<PublicationStatus | undefined> {
  const entry = entryFor(id);
  if (entry.pending) return entry.pending;
  if (!force && Date.now() - entry.updated < 1000) return Promise.resolve(entry.snapshot.status);
  entry.pending = getPublicationStatus(id).then(status => {
    entry.snapshot = { status }; entry.updated = Date.now(); notify(entry); return status;
  }).catch(reason => { entry.snapshot = { ...entry.snapshot, error: String(reason) }; notify(entry); return undefined; }).finally(() => {
    entry.pending = undefined; schedule(id, entry);
  });
  return entry.pending;
}
export function setPublicationPosting(id: string, posting: boolean) {
  const entry = entryFor(id); entry.posting = posting;
  if (posting && entry.snapshot.status) entry.snapshot = { status: { ...entry.snapshot.status, inProgress: true, progress: { phase: "packaging", uploadedBytes: 0, totalBytes: 0 } } };
  notify(entry); schedule(id, entry);
}
export function usePublication(id?: string) {
  const subscribe = useCallback((listener: () => void) => {
    if (!id) return () => {};
    const entry = entryFor(id); entry.listeners.add(listener);
    if (entry.listeners.size === 1) { void refreshPublication(id, false); entry.focus = () => { void refreshPublication(id); }; window.addEventListener("focus", entry.focus); }
    return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { clearTimeout(entry.timer); if (entry.focus) window.removeEventListener("focus", entry.focus); entry.focus = undefined; } };
  }, [id]);
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => id ? entryFor(id).snapshot : empty, [id]));
  return { ...snapshot, refresh: () => id ? refreshPublication(id) : Promise.resolve(undefined) };
}
