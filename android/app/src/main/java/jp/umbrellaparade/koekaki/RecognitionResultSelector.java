package jp.umbrellaparade.koekaki;

/** Reconciles one recognizer's final result with its last partial result. */
final class RecognitionResultSelector {
    private RecognitionResultSelector() {
    }

    /**
     * Prefers the recognizer's final text while recovering terminal sentence punctuation that
     * disappeared between an otherwise identical partial and final result.
     */
    static String select(String finalText, String partialText) {
        String finalized = normalize(finalText);
        String partial = normalize(partialText);
        if (finalized.isEmpty()) return partial;
        if (partial.isEmpty()) return finalized;

        int finalizedBaseEnd = terminalPunctuationStart(finalized);
        int partialBaseEnd = terminalPunctuationStart(partial);
        String finalizedBase = finalized.substring(0, finalizedBaseEnd);
        String partialBase = partial.substring(0, partialBaseEnd);

        boolean finalHasPunctuation = finalizedBaseEnd < finalized.length();
        boolean partialHasPunctuation = partialBaseEnd < partial.length();
        if (!finalHasPunctuation
                && partialHasPunctuation
                && finalizedBase.equals(partialBase)) {
            return finalized + partial.substring(partialBaseEnd);
        }
        return finalized;
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }

    private static int terminalPunctuationStart(String value) {
        int index = value.length();
        while (index > 0 && isSentencePunctuation(value.charAt(index - 1))) {
            index -= 1;
        }
        return index;
    }

    private static boolean isSentencePunctuation(char value) {
        return value == '。'
                || value == '？'
                || value == '！'
                || value == '.'
                || value == '?'
                || value == '!';
    }
}
