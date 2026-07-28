package jp.umbrellaparade.koekaki;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;

/** One-shot, cancellable HTTPS client for OpenAI's Responses API. */
public final class OpenAiPolishClient {
    static final String ENDPOINT = "https://api.openai.com/v1/responses";
    static final int CONNECT_TIMEOUT_MS = 10_000;
    static final int READ_TIMEOUT_MS = 75_000;
    static final int MAX_INPUT_CHARS = 20_000;
    static final int MAX_INSTRUCTIONS_CHARS = 24_000;
    static final int MAX_REQUEST_BYTES = 256 * 1024;
    static final int MAX_RESPONSE_BYTES = 512 * 1024;
    static final int MAX_OUTPUT_TOKENS = 8_192;
    private static final int CONNECTION_TEST_OUTPUT_TOKENS = 128;
    private static final String DEFAULT_MODEL = "gpt-4.1-mini";
    private static final double EDITING_TEMPERATURE = 0.2d;
    private static final Pattern LOW_TEMPERATURE_TEXT_MODEL = Pattern.compile(
            "^gpt-(?:4\\.1(?:-(?:mini|nano))?|4o(?:-mini)?)"
                    + "(?:-[0-9]{4}-[0-9]{2}-[0-9]{2})?$");

    private final String model;
    private final ConnectionFactory connectionFactory;
    private final AtomicBoolean started = new AtomicBoolean(false);
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final AtomicReference<HttpsURLConnection> activeConnection = new AtomicReference<>();
    private final AtomicReference<Closeable> activeStream = new AtomicReference<>();

    public OpenAiPolishClient() {
        this(DEFAULT_MODEL);
    }

    public OpenAiPolishClient(String model) {
        this(model, url -> (HttpsURLConnection) url.openConnection());
    }

    OpenAiPolishClient(String model, ConnectionFactory connectionFactory) {
        this.model = validateModel(model);
        this.connectionFactory = Objects.requireNonNull(connectionFactory, "connectionFactory");
    }

    /** Performs one text-polishing request. Call this method from a worker thread. */
    public String polish(String apiKey, String instructions, String input) throws OpenAiException {
        validateText(instructions, MAX_INSTRUCTIONS_CHARS, false);
        validateText(input, MAX_INPUT_CHARS, false);
        JSONObject request = buildRequest(model, instructions, input, MAX_OUTPUT_TOKENS);
        String response = execute(apiKey, request);
        try {
            String result = OpenAiResponseParser.parsePolishedText(response);
            ensureNotCancelled();
            return result;
        } catch (OpenAiResponseParser.ParseException exception) {
            throw new OpenAiException(ErrorKind.INVALID_RESPONSE, 0);
        }
    }

    /** Tests authentication and model inference using a fixed payload with no user text. */
    public void testConnection(String apiKey) throws OpenAiException {
        JSONObject request = buildRequest(
                model,
                "Reply with only the word OK.",
                "Connection test.",
                CONNECTION_TEST_OUTPUT_TOKENS);
        String response = execute(apiKey, request);
        try {
            OpenAiResponseParser.parsePolishedText(response);
            ensureNotCancelled();
        } catch (OpenAiResponseParser.ParseException exception) {
            throw new OpenAiException(ErrorKind.INVALID_RESPONSE, 0);
        }
    }

    /**
     * Cancels this client permanently. Closing the active stream and disconnecting are best-effort;
     * the atomic cancellation flag remains the authority for discarding late results.
     */
    public void cancel() {
        cancelled.set(true);
        closeQuietly(activeStream.getAndSet(null));
        HttpsURLConnection connection = activeConnection.getAndSet(null);
        if (connection != null) connection.disconnect();
    }

    static JSONObject buildRequest(
            String model,
            String instructions,
            String input,
            int maxOutputTokens) throws OpenAiException {
        try {
            String validatedModel = validateModel(model);
            JSONObject request = new JSONObject()
                    .put("model", validatedModel)
                    .put("instructions", instructions)
                    .put("input", input)
                    .put("store", false)
                    .put("max_output_tokens", Math.max(1,
                            Math.min(MAX_OUTPUT_TOKENS, maxOutputTokens)));
            if (LOW_TEMPERATURE_TEXT_MODEL.matcher(validatedModel).matches()) {
                request.put("temperature", EDITING_TEMPERATURE);
            }
            return request;
        } catch (JSONException exception) {
            throw new OpenAiException(ErrorKind.INVALID_REQUEST, 0);
        }
    }

    private String execute(String apiKeyInput, JSONObject request) throws OpenAiException {
        ensureNotCancelled();
        if (!started.compareAndSet(false, true)) {
            throw new OpenAiException(ErrorKind.ALREADY_USED, 0);
        }

        final String apiKey;
        try {
            apiKey = ApiKeyInputPolicy.normalize(apiKeyInput);
        } catch (ApiKeyInputPolicy.ValidationException exception) {
            throw new OpenAiException(ErrorKind.INVALID_API_KEY, 0);
        }

        byte[] requestBytes = request.toString().getBytes(StandardCharsets.UTF_8);
        if (requestBytes.length > MAX_REQUEST_BYTES) {
            throw new OpenAiException(ErrorKind.INPUT_TOO_LARGE, 0);
        }

        HttpsURLConnection connection = null;
        try {
            connection = connectionFactory.open(new URL(ENDPOINT));
            ensureNotCancelled();
            if (!activeConnection.compareAndSet(null, connection)) {
                throw new OpenAiException(ErrorKind.ALREADY_USED, 0);
            }
            // cancel() can win between the check above and publishing this connection.
            // Re-check after publication so cancellation always observes or rejects it.
            ensureNotCancelled();

            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setUseCaches(false);
            connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setFixedLengthStreamingMode(requestBytes.length);

            OutputStream output = connection.getOutputStream();
            setActiveStream(output);
            try {
                output.write(requestBytes);
                output.flush();
            } finally {
                clearAndCloseStream(output);
            }
            ensureNotCancelled();

            int status = connection.getResponseCode();
            ensureNotCancelled();
            if (status < 200 || status >= 300) {
                closeQuietly(connection.getErrorStream());
                throw errorForStatus(status);
            }

            InputStream input = connection.getInputStream();
            setActiveStream(input);
            try {
                return readBounded(input);
            } finally {
                clearAndCloseStream(input);
            }
        } catch (OpenAiException exception) {
            throw exception;
        } catch (SocketTimeoutException exception) {
            if (cancelled.get()) throw new OpenAiException(ErrorKind.CANCELLED, 0);
            throw new OpenAiException(ErrorKind.TIMEOUT, 0);
        } catch (IOException exception) {
            if (cancelled.get()) throw new OpenAiException(ErrorKind.CANCELLED, 0);
            throw new OpenAiException(ErrorKind.NETWORK, 0);
        } finally {
            closeQuietly(activeStream.getAndSet(null));
            if (connection != null) {
                activeConnection.compareAndSet(connection, null);
                connection.disconnect();
            }
            Arrays.fill(requestBytes, (byte) 0);
        }
    }

    private String readBounded(InputStream input) throws IOException, OpenAiException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4_096];
        while (true) {
            ensureNotCancelled();
            int read = input.read(buffer);
            if (read < 0) break;
            if (output.size() + read > MAX_RESPONSE_BYTES) {
                throw new OpenAiException(ErrorKind.RESPONSE_TOO_LARGE, 0);
            }
            output.write(buffer, 0, read);
        }
        ensureNotCancelled();
        byte[] responseBytes = output.toByteArray();
        try {
            return new String(responseBytes, StandardCharsets.UTF_8);
        } finally {
            Arrays.fill(responseBytes, (byte) 0);
        }
    }

    private void setActiveStream(Closeable stream) throws OpenAiException {
        if (!activeStream.compareAndSet(null, stream)) {
            closeQuietly(stream);
            throw new OpenAiException(ErrorKind.ALREADY_USED, 0);
        }
        if (cancelled.get()) {
            closeQuietly(activeStream.getAndSet(null));
            throw new OpenAiException(ErrorKind.CANCELLED, 0);
        }
    }

    private void clearAndCloseStream(Closeable stream) {
        activeStream.compareAndSet(stream, null);
        closeQuietly(stream);
    }

    private void ensureNotCancelled() throws OpenAiException {
        if (cancelled.get()) throw new OpenAiException(ErrorKind.CANCELLED, 0);
    }

    private static String validateModel(String value) {
        if (value == null || value.isEmpty() || value.length() > 128) {
            throw new IllegalArgumentException("Invalid OpenAI model name");
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean allowed = (character >= 'a' && character <= 'z')
                    || (character >= 'A' && character <= 'Z')
                    || (character >= '0' && character <= '9')
                    || character == '-' || character == '_' || character == '.' || character == ':';
            if (!allowed) throw new IllegalArgumentException("Invalid OpenAI model name");
        }
        return value;
    }

    private static void validateText(String value, int maximumLength, boolean allowEmpty)
            throws OpenAiException {
        if (value == null || (!allowEmpty && value.trim().isEmpty())) {
            throw new OpenAiException(ErrorKind.INVALID_REQUEST, 0);
        }
        if (value.length() > maximumLength) {
            throw new OpenAiException(ErrorKind.INPUT_TOO_LARGE, 0);
        }
    }

    static OpenAiException errorForStatus(int status) {
        if (status >= 300 && status < 400) {
            return new OpenAiException(ErrorKind.REDIRECT_BLOCKED, status);
        }
        if (status == 401) return new OpenAiException(ErrorKind.AUTHENTICATION, status);
        if (status == 403) return new OpenAiException(ErrorKind.PERMISSION, status);
        if (status == 404) return new OpenAiException(ErrorKind.MODEL_NOT_FOUND, status);
        if (status == 408) return new OpenAiException(ErrorKind.TIMEOUT, status);
        if (status == 413) return new OpenAiException(ErrorKind.INPUT_TOO_LARGE, status);
        if (status == 429) return new OpenAiException(ErrorKind.RATE_LIMIT, status);
        if (status >= 500) return new OpenAiException(ErrorKind.SERVER, status);
        return new OpenAiException(ErrorKind.INVALID_REQUEST, status);
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            // No secret or request content is logged.
        }
    }

    @FunctionalInterface
    interface ConnectionFactory {
        HttpsURLConnection open(URL url) throws IOException;
    }

    public enum ErrorKind {
        CANCELLED,
        ALREADY_USED,
        INVALID_API_KEY,
        AUTHENTICATION,
        PERMISSION,
        MODEL_NOT_FOUND,
        RATE_LIMIT,
        TIMEOUT,
        NETWORK,
        SERVER,
        REDIRECT_BLOCKED,
        INPUT_TOO_LARGE,
        RESPONSE_TOO_LARGE,
        INVALID_REQUEST,
        INVALID_RESPONSE
    }

    /** Contains only a fixed safe user message and an HTTP status, never a server response body. */
    public static final class OpenAiException extends Exception {
        private final ErrorKind kind;
        private final int httpStatus;

        OpenAiException(ErrorKind kind, int httpStatus) {
            super(messageFor(kind));
            this.kind = kind;
            this.httpStatus = httpStatus;
        }

        public ErrorKind getKind() {
            return kind;
        }

        public int getHttpStatus() {
            return httpStatus;
        }

        private static String messageFor(ErrorKind kind) {
            switch (kind) {
                case CANCELLED:
                    return "OpenAIへの接続をキャンセルしました。";
                case INVALID_API_KEY:
                case AUTHENTICATION:
                    return "OpenAIのAPIキーが無効です。設定画面で確認してください。";
                case PERMISSION:
                    return "このAPIキーでは指定されたモデルを使用できません。";
                case MODEL_NOT_FOUND:
                    return "指定されたOpenAIモデルを利用できません。";
                case RATE_LIMIT:
                    return "OpenAIの利用上限またはレート制限に達しました。";
                case TIMEOUT:
                    return "OpenAIの応答が時間内に返りませんでした。";
                case NETWORK:
                    return "OpenAIに接続できませんでした。通信状態を確認してください。";
                case SERVER:
                    return "OpenAI側で一時的な問題が発生しています。";
                case REDIRECT_BLOCKED:
                    return "安全でない接続先変更を拒否しました。";
                case INPUT_TOO_LARGE:
                    return "整形する文章が長すぎます。";
                case RESPONSE_TOO_LARGE:
                    return "OpenAIの応答が大きすぎます。";
                case ALREADY_USED:
                    return "OpenAI接続処理を同時に実行できません。";
                case INVALID_RESPONSE:
                    return "OpenAIから整形結果を取得できませんでした。";
                default:
                    return "OpenAIへのリクエストを処理できませんでした。";
            }
        }
    }
}
