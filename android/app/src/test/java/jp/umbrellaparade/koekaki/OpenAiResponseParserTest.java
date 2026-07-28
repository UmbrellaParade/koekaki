package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class OpenAiResponseParserTest {
    @Test
    public void parsePolishedText_extractsOnlyAssistantOutputText() throws Exception {
        String response = "{\"status\":\"completed\",\"output\":["
                + "{\"type\":\"reasoning\",\"content\":[]},"
                + "{\"type\":\"message\",\"content\":["
                + "{\"type\":\"output_text\",\"text\":\"整えた文章です。\"},"
                + "{\"type\":\"refusal\",\"refusal\":\"ignored\"}"
                + "]},"
                + "{\"type\":\"message\",\"content\":["
                + "{\"type\":\"output_text\",\"text\":\"二段落目です。\"}"
                + "]}]}";

        assertEquals(
                "整えた文章です。\n二段落目です。",
                OpenAiResponseParser.parsePolishedText(response));
    }

    @Test
    public void parsePolishedText_rejectsMalformedAndMissingText() {
        assertRejected("not json", OpenAiResponseParser.Reason.MALFORMED);
        assertRejected("{}", OpenAiResponseParser.Reason.MISSING_TEXT);
        assertRejected(
                "{\"output\":[{\"type\":\"message\",\"content\":[]}]}",
                OpenAiResponseParser.Reason.MISSING_TEXT);
        assertRejected(
                "{\"status\":\"incomplete\",\"output\":[{\"type\":\"message\","
                        + "\"content\":[{\"type\":\"output_text\",\"text\":\"途中\"}]}]}",
                OpenAiResponseParser.Reason.INCOMPLETE);
    }

    @Test
    public void parsePolishedText_rejectsOversizedOutput() {
        String response = "{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":["
                + "{\"type\":\"output_text\",\"text\":\""
                + "x".repeat(OpenAiResponseParser.MAX_OUTPUT_CHARS + 1)
                + "\"}]}]}";
        assertRejected(response, OpenAiResponseParser.Reason.TOO_LARGE);
    }

    private static void assertRejected(String value, OpenAiResponseParser.Reason expectedReason) {
        try {
            OpenAiResponseParser.parsePolishedText(value);
            fail("Expected parse failure");
        } catch (OpenAiResponseParser.ParseException exception) {
            assertEquals(expectedReason, exception.getReason());
        }
    }
}
