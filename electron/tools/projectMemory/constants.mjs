/** Shared constants. Kept in their own module so fingerprint/sections/index can all import them
 *  without an import cycle. */

/** Filename the project memory is written to, at the working-directory root. */
export const MEMORY_FILE = "ZERAIX.md";

/** Prefix of the transient file used for atomic writes (see markdown.writeAtomic). */
export const TMP_PREFIX = `${MEMORY_FILE}.tmp-`;
