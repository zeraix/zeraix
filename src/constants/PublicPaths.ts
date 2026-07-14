/**
 * Public paths that never require a session. Login is no longer a route gate —
 * the whole app is usable as a guest — so this list is now only used by the
 * root layout to decide when to briefly withhold render during initial load.
 */
export const PUBLIC_PATHS = ['/'];