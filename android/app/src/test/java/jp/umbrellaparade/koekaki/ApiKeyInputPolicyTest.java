package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class ApiKeyInputPolicyTest {
    @Test
    public void normalize_trimsOuterSpacesWithoutFixingPrefix() throws Exception {
        assertEquals("future.key-format_123-ABC", ApiKeyInputPolicy.normalize(
                "  future.key-format_123-ABC  "));
    }

    @Test
    public void normalize_acceptsMaximumLength() throws Exception {
        assertEquals(ApiKeyInputPolicy.MAX_LENGTH,
                ApiKeyInputPolicy.normalize("x".repeat(ApiKeyInputPolicy.MAX_LENGTH)).length());
    }

    @Test
    public void normalize_rejectsEmptyAndOversizedValues() {
        assertRejected(null, ApiKeyInputPolicy.Reason.EMPTY);
        assertRejected("   ", ApiKeyInputPolicy.Reason.EMPTY);
        assertRejected(
                "x".repeat(ApiKeyInputPolicy.MAX_LENGTH + 1),
                ApiKeyInputPolicy.Reason.TOO_LONG);
    }

    @Test
    public void normalize_rejectsInternalWhitespaceNewlinesAndControls() {
        assertRejected("part one", ApiKeyInputPolicy.Reason.INVALID_CHARACTER);
        assertRejected("part\tone", ApiKeyInputPolicy.Reason.INVALID_CHARACTER);
        assertRejected("part\none", ApiKeyInputPolicy.Reason.INVALID_CHARACTER);
        assertRejected("\npart", ApiKeyInputPolicy.Reason.INVALID_CHARACTER);
        assertRejected("part\u0000one", ApiKeyInputPolicy.Reason.INVALID_CHARACTER);
        assertRejected("part\u3000one", ApiKeyInputPolicy.Reason.INVALID_CHARACTER);
    }

    private static void assertRejected(String value, ApiKeyInputPolicy.Reason expectedReason) {
        try {
            ApiKeyInputPolicy.normalize(value);
            fail("Expected validation failure");
        } catch (ApiKeyInputPolicy.ValidationException exception) {
            assertEquals(expectedReason, exception.getReason());
        }
    }
}
