package jp.umbrellaparade.koekaki;

final class TranscriptAccumulator {
    private static final int MAX_OVERLAP = 120;
    // One-character matches are common by chance in Japanese (for example ます + すみません).
    // Two or more characters are a better signal that a restarted recognizer repeated a boundary.
    private static final int MIN_OVERLAP = 2;

    private TranscriptAccumulator() {}

    static String append(String existing, String incoming) {
        return appendInternal(existing, incoming, false);
    }

    /**
     * Appends a completed recognition segment while retaining a weak sentence boundary.
     *
     * <p>Exact repeats, cumulative results, and meaningful boundary overlaps are still merged.
     * Unrelated segments are separated with a newline so the polishing stage can distinguish a
     * pause from two Japanese phrases that happened to become adjacent.</p>
     */
    static String appendWithBoundary(String existing, String incoming) {
        return appendInternal(existing, incoming, true);
    }

    private static String appendInternal(String existing, String incoming, boolean keepBoundary) {
        String before = existing == null ? "" : existing.trim();
        String next = incoming == null ? "" : incoming.trim();
        if (next.isEmpty()) return before;
        if (before.isEmpty()) return next;
        if (before.endsWith(next)) return before;
        if (next.startsWith(before)) return next;

        int limit = Math.min(Math.min(before.length(), next.length()), MAX_OVERLAP);
        for (int length = limit; length >= MIN_OVERLAP; length--) {
            if (before.regionMatches(before.length() - length, next, 0, length)) {
                return before + next.substring(length);
            }
        }

        if (keepBoundary) return before + "\n" + next;
        return before + (needsSpace(before, next) ? " " : "") + next;
    }

    private static boolean needsSpace(String before, String next) {
        char left = before.charAt(before.length() - 1);
        char right = next.charAt(0);
        return isAsciiWord(left) && isAsciiWord(right);
    }

    private static boolean isAsciiWord(char value) {
        return (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
    }
}
