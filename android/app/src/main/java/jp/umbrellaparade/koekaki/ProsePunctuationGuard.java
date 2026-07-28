package jp.umbrellaparade.koekaki;

/** A conservative last-line safety net for prose modes when recognition or AI omits punctuation. */
final class ProsePunctuationGuard {
    private static final String[] QUESTION_WORDS = {
            "クエスチョンマーク",
            "はてなのマーク",
            "ハテナのマーク",
            "はてなマーク",
            "ハテナマーク"
    };

    private static final String[] EXCLAMATION_WORDS = {
            "エクスクラメーションマーク",
            "びっくりマーク"
    };

    private static final String CLOSING_QUOTES = "」』";
    private static final String TERMINAL_MARKS = "。！？!?…．.";

    private ProsePunctuationGuard() {
    }

    static String apply(String input, String modeId) {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty() || !isProseMode(modeId)) return text;

        Replacement replacement = replaceSpokenTerminalMark(text, QUESTION_WORDS, '？');
        if (replacement.replaced) return replacement.text;
        replacement = replaceSpokenTerminalMark(text, EXCLAMATION_WORDS, '！');
        if (replacement.replaced) return replacement.text;

        int insertion = terminalInsertionIndex(text);
        if (insertion <= 0 || isTerminalMark(text.charAt(insertion - 1))) return text;

        String sentence = text.substring(0, insertion).trim();
        if (sentence.isEmpty()) return text;
        char mark = looksLikeQuestion(sentence) ? '？' : '。';
        return text.substring(0, insertion) + mark + text.substring(insertion);
    }

    private static boolean isProseMode(String modeId) {
        if (modeId == null) return false;
        switch (modeId) {
            case "standard":
            case "mail":
            case "chat":
            case "blog":
            case "polite":
            case "casual":
                return true;
            default:
                return false;
        }
    }

    private static Replacement replaceSpokenTerminalMark(
            String text,
            String[] spokenForms,
            char punctuation) {
        int insertion = terminalInsertionIndex(text);
        String body = text.substring(0, insertion).trim();
        String closing = text.substring(insertion);
        for (String spoken : spokenForms) {
            if (!body.endsWith(spoken)) continue;
            String withoutSpoken = body.substring(0, body.length() - spoken.length()).trim();
            if (withoutSpoken.isEmpty()) return new Replacement(text, false);
            return new Replacement(withoutSpoken + punctuation + closing, true);
        }
        return new Replacement(text, false);
    }

    private static int terminalInsertionIndex(String text) {
        int index = text.length();
        while (index > 0 && CLOSING_QUOTES.indexOf(text.charAt(index - 1)) >= 0) {
            index--;
        }
        return index;
    }

    private static boolean isTerminalMark(char value) {
        return TERMINAL_MARKS.indexOf(value) >= 0;
    }

    private static boolean looksLikeQuestion(String sentence) {
        String compact = sentence.replace(" ", "").replace("　", "");
        return compact.endsWith("ですか")
                || compact.endsWith("ますか")
                || compact.endsWith("ませんか")
                || compact.endsWith("でしょうか")
                || compact.endsWith("だろうか")
                || compact.endsWith("なのか")
                || compact.endsWith("かな")
                || compact.endsWith("かしら")
                || compact.endsWith("どうです")
                || compact.endsWith("どうでしょう")
                || compact.endsWith("いかがです")
                || compact.endsWith("いかがでしょう")
                || compact.endsWith("どうしたらいい")
                || compact.endsWith("どうすればいい");
    }

    private static final class Replacement {
        private final String text;
        private final boolean replaced;

        private Replacement(String text, boolean replaced) {
            this.text = text;
            this.replaced = replaced;
        }
    }
}
