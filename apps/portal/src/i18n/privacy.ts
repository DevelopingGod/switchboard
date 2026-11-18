/** Chat notes added in M3a (auto-private, pasted secrets, long-thread summaries). Imported only by the
 * lazy PrivacyNotes chunk, so /chat's first load doesn't carry them. */
import { lookup, type Leaves, type Vars } from "./strings";

export const privacyStrings = {
  sensitive: {
    kept: "Kept local: this looks sensitive ({category}).",
    why: "Messages about health, money, legal matters or other private details stay on this machine, and so does the rest of this chat. Turn this off in Settings → Privacy.",
    override: "Not sensitive — use cloud",
    overriding: "Switching to the cloud…",
    category: { health: "health", finance: "money", legal: "legal", personal: "personal details", secret: "a secret" },
  },
  secret: {
    note: "Looks like you pasted a secret — kept local and masked. Consider rotating it.",
    kinds: "Found: {kinds}",
    kind: { api_key: "API key", token: "token", private_key: "private key", password: "password", card: "card number" },
  },
  summary: {
    title: "Summary of earlier messages",
    covers: "Covers {count} earlier messages. Only this summary and the messages after it are sent to the model.",
    by: "Written by {model}",
  },
};

export type PrivacyKey = Leaves<typeof privacyStrings>;
export const tPriv = (key: PrivacyKey, vars?: Vars) => lookup(privacyStrings, key, vars);
