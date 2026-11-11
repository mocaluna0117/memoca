/**
 * Said in the page (an event on window) as the server takes this device for
 * no one: its sign-in lapsed, its token not renewed. The sync engine says
 * it, as a push is refused for it or the pull comes as no one's; the bridge
 * to Better Auth (components/providers/convex-auth) asks for a token again,
 * in a window out of sight too, which does not by itself.
 */
export const SIGN_IN_LOST = "memoca:sign-in-lost";
