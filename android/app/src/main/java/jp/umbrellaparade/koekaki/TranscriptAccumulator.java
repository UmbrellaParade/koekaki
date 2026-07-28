package jp.umbrellaparade.koekaki;

final class TranscriptAccumulator {
    private static final int MAX_OVERLAP = 120;

    private TranscriptAccumulator() {}

    static String append(String existing, String incoming) {
        String before = existing == null ? "" : existing.trim();
        String next = incoming == null ? "" : incoming.trim();
        if (next.isEmpty()) return before;
        if (before.isEmpty()) return next;
        if (before.endsWith(next)) return before;
        if (next.startsWith(before)) return next;

        int limit = Math.min(Math.min(before.length(), next.length()), MAX_OVERLAP);
        for (int length = limit; length > 0; length--) {
            if (before.regionMatches(before.length() - length, next, 0, length)) {
                return before + next.substring(length);
            }
        }

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
