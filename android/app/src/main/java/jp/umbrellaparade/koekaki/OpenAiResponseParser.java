package jp.umbrellaparade.koekaki;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Extracts plain assistant text from a raw Responses API response. */
public final class OpenAiResponseParser {
    public static final int MAX_OUTPUT_CHARS = 20_000;

    private OpenAiResponseParser() {
    }

    public static String parsePolishedText(String responseBody) throws ParseException {
        if (responseBody == null || responseBody.isEmpty()) {
            throw new ParseException(Reason.MALFORMED);
        }

        try {
            JSONObject root = new JSONObject(responseBody);
            JSONArray output = root.optJSONArray("output");
            if (output == null) throw new ParseException(Reason.MISSING_TEXT);
            if (!"completed".equals(root.optString("status"))) {
                throw new ParseException(Reason.INCOMPLETE);
            }

            StringBuilder text = new StringBuilder();
            for (int outputIndex = 0; outputIndex < output.length(); outputIndex++) {
                JSONObject item = output.optJSONObject(outputIndex);
                if (item == null || !"message".equals(item.optString("type"))) continue;
                JSONArray content = item.optJSONArray("content");
                if (content == null) continue;

                for (int contentIndex = 0; contentIndex < content.length(); contentIndex++) {
                    JSONObject part = content.optJSONObject(contentIndex);
                    if (part == null || !"output_text".equals(part.optString("type"))) continue;
                    String value = part.optString("text", "");
                    if (value.isEmpty()) continue;
                    if (text.length() > 0) text.append('\n');
                    if (text.length() + value.length() > MAX_OUTPUT_CHARS) {
                        throw new ParseException(Reason.TOO_LARGE);
                    }
                    text.append(value);
                }
            }

            String result = text.toString().trim();
            if (result.isEmpty()) throw new ParseException(Reason.MISSING_TEXT);
            return result;
        } catch (ParseException exception) {
            throw exception;
        } catch (JSONException exception) {
            throw new ParseException(Reason.MALFORMED);
        }
    }

    public enum Reason {
        MALFORMED,
        MISSING_TEXT,
        INCOMPLETE,
        TOO_LARGE
    }

    /** Parse failures never contain the response body. */
    public static final class ParseException extends Exception {
        private final Reason reason;

        ParseException(Reason reason) {
            super(reason == Reason.TOO_LARGE
                    ? "OpenAIの応答が長すぎます。"
                    : reason == Reason.INCOMPLETE
                            ? "OpenAIの応答が完了しませんでした。"
                            : "OpenAIから整形結果を取得できませんでした。");
            this.reason = reason;
        }

        public Reason getReason() {
            return reason;
        }
    }
}
