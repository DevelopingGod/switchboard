/** A message composed on Home (or a quick-start chip), handed to /chat which sends it on arrival. */
export const PENDING_KEY = "switchboard.pending.v1";

export interface PendingMessage {
  text: string;
  private: boolean;
  autonomy: number;
  temperature: number;
  think?: boolean;
}

/** Stores the message for /chat; false when storage is unavailable (private window etc.). */
export function handOff(msg: PendingMessage): boolean {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}
