package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class KoekakiSettingsTest {
    @Test
    public void defaultsMatchTheWebPolishSettings() {
        assertTrue(KoekakiSettings.DEFAULT_AI_POLISH_ENABLED);
        assertEquals("standard", KoekakiSettings.DEFAULT_MODE_ID);
        assertEquals("gpt-4.1-mini", KoekakiSettings.DEFAULT_OPENAI_MODEL);
        assertTrue(KoekakiSettings.DEFAULT_USE_BUILTIN_TERMS);
    }

    @Test
    public void textLimitHandlesNullAndCapsLongValues() {
        assertEquals("", KoekakiSettings.limitText(null, 10));
        assertEquals("abc", KoekakiSettings.limitText("abcdef", 3));
        assertEquals("abcdef", KoekakiSettings.limitText("abcdef", 10));
    }
}
