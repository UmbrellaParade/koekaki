package jp.umbrellaparade.koekaki;

/**
 * Shared preference keys and conservative defaults for Koekaki's Android settings.
 *
 * <p>The API key is deliberately not represented here. It is stored separately by the encrypted
 * credential store. Callers must also require that a key exists before treating
 * {@link #DEFAULT_AI_POLISH_ENABLED} as enabled.</p>
 */
public final class KoekakiSettings {
    public static final String PREFERENCES_NAME = "koekaki_settings";

    public static final String KEY_AUTO_RETURN_KEYBOARD = "auto_return_keyboard";
    public static final String KEY_AI_POLISH_ENABLED = "ai_polish_enabled";
    public static final String KEY_ACTIVE_MODE_ID = "active_mode_id";
    public static final String KEY_OPENAI_MODEL = "openai_model";
    public static final String KEY_USE_BUILTIN_TERMS = "use_builtin_terms";
    public static final String KEY_USER_DICTIONARY = "user_dictionary";
    public static final String KEY_STYLE_SAMPLE = "style_sample";

    public static final boolean DEFAULT_AUTO_RETURN_KEYBOARD = false;
    public static final boolean DEFAULT_AI_POLISH_ENABLED = true;
    public static final String DEFAULT_MODE_ID = "standard";
    public static final String DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
    public static final boolean DEFAULT_USE_BUILTIN_TERMS = true;

    /** Maximum saved dictionary source length before comments and invalid lines are filtered. */
    public static final int MAX_DICTIONARY_TEXT_CHARS = 8_000;

    /** Matches the Web app's maximum style sample included in an AI prompt. */
    public static final int MAX_STYLE_SAMPLE_CHARS = 2_000;

    /** Leaves room for a long Japanese transcript inside the client's bounded JSON request. */
    public static final int MAX_SYSTEM_PROMPT_CHARS = 16_000;

    private KoekakiSettings() {
    }

    /** Returns at most {@code maxChars} UTF-16 code units and treats {@code null} as empty. */
    public static String limitText(String value, int maxChars) {
        if (value == null || maxChars <= 0) {
            return "";
        }
        return value.length() <= maxChars ? value : value.substring(0, maxChars);
    }
}
