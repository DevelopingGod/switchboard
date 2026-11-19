/** Window events between the chat screen and the sidebar's recents (M3b). */
export const THREADS_CHANGED = "sb:threads-changed"; // the list changed (new chat, new title, delete): reload it
export const THREAD_UPDATED = "sb:thread-updated"; // detail: the updated ChatThread (rename, pin)

export const notifyThreadsChanged = () => window.dispatchEvent(new Event(THREADS_CHANGED));
