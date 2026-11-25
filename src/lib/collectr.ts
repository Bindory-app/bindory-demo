/**
 * "Sync from Collectr": the collector pastes their public Collectr link. Collectr has no public
 * API, and its showcase pages load the card list privately in the browser, so Mori cannot read
 * the cards from the link yet. Mori answers this message itself (no agent run), honestly, and
 * never invents an import.
 */
const SYNC = /^\s*sync my collectr collection\b[:\s]*(\S*)/i;

/** The pasted link when the message is a Collectr sync request, "" when the link is missing. */
export function collectrSyncLink(message: string): string | null {
  const m = SYNC.exec(message);
  return m ? (m[1] ?? "") : null;
}

/** A public Collectr showcase link (https, getcollectr.com), or null. */
export function isCollectrLink(link: string): boolean {
  try {
    const u = new URL(link);
    return (
      u.protocol === "https:" &&
      (u.hostname === "getcollectr.com" || u.hostname.endsWith(".getcollectr.com"))
    );
  } catch {
    return false;
  }
}

export function collectrReply(link: string): string {
  if (!isCollectrLink(link))
    return "That does not look like a Collectr link. In Collectr, open Profile, then Settings, turn on Portfolio Sharing and copy the link it gives you (it starts with https://app.getcollectr.com/). Then tap Sync from Collectr and paste it.";
  return "Thanks, I have your Collectr link. I can't bring your cards across from Collectr yet: Collectr doesn't let other apps read collections, even public ones. For now, add your cards here with a photo, or type the card name and number, and I'll put each one in the binder you choose.";
}
