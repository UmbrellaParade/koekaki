package jp.umbrellaparade.koekaki;

/** Validates an API key without assuming any provider-specific prefix. */
public final class ApiKeyInputPolicy {
    public static final int MAX_LENGTH = 512;

    private ApiKeyInputPolicy() {
    }

    /**
     * Removes ordinary leading/trailing spaces and rejects characters that must never reach an
     * HTTP Authorization header.
     */
    public static String normalize(String input) throws ValidationException {
        if (input == null) {
            throw new ValidationException(Reason.EMPTY);
        }

        for (int index = 0; index < input.length(); index++) {
            char value = input.charAt(index);
            if (value == '\r' || value == '\n' || Character.isISOControl(value)) {
                throw new ValidationException(Reason.INVALID_CHARACTER);
            }
        }

        String normalized = input.trim();
        if (normalized.isEmpty()) {
            throw new ValidationException(Reason.EMPTY);
        }
        if (normalized.length() > MAX_LENGTH) {
            throw new ValidationException(Reason.TOO_LONG);
        }
        for (int index = 0; index < normalized.length(); index++) {
            if (Character.isWhitespace(normalized.charAt(index))) {
                throw new ValidationException(Reason.INVALID_CHARACTER);
            }
        }
        return normalized;
    }

    public enum Reason {
        EMPTY,
        TOO_LONG,
        INVALID_CHARACTER
    }

    /** The message is deliberately fixed and never contains the rejected input. */
    public static final class ValidationException extends Exception {
        private final Reason reason;

        ValidationException(Reason reason) {
            super(messageFor(reason));
            this.reason = reason;
        }

        public Reason getReason() {
            return reason;
        }

        private static String messageFor(Reason reason) {
            if (reason == Reason.EMPTY) return "APIキーを入力してください。";
            if (reason == Reason.TOO_LONG) return "APIキーが長すぎます。";
            return "APIキーに使用できない文字が含まれています。";
        }
    }
}
