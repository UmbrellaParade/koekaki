package jp.umbrellaparade.koekaki;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.Principal;
import java.security.cert.Certificate;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLPeerUnverifiedException;

public final class OpenAiPolishClientTest {
    @Test
    public void buildRequest_usesBoundedNonStoredResponsesPayload() throws Exception {
        JSONObject request = OpenAiPolishClient.buildRequest(
                "gpt-4.1-mini",
                "引用符 \" と改行\nを保つ",
                "日本語の入力",
                OpenAiPolishClient.MAX_OUTPUT_TOKENS + 100);

        assertEquals("gpt-4.1-mini", request.getString("model"));
        assertEquals("引用符 \" と改行\nを保つ", request.getString("instructions"));
        assertEquals("日本語の入力", request.getString("input"));
        assertFalse(request.getBoolean("store"));
        assertEquals(OpenAiPolishClient.MAX_OUTPUT_TOKENS,
                request.getInt("max_output_tokens"));
    }

    @Test
    public void errorForStatus_returnsFixedClassification() {
        assertEquals(OpenAiPolishClient.ErrorKind.REDIRECT_BLOCKED,
                OpenAiPolishClient.errorForStatus(302).getKind());
        assertEquals(OpenAiPolishClient.ErrorKind.AUTHENTICATION,
                OpenAiPolishClient.errorForStatus(401).getKind());
        assertEquals(OpenAiPolishClient.ErrorKind.PERMISSION,
                OpenAiPolishClient.errorForStatus(403).getKind());
        assertEquals(OpenAiPolishClient.ErrorKind.MODEL_NOT_FOUND,
                OpenAiPolishClient.errorForStatus(404).getKind());
        assertEquals(OpenAiPolishClient.ErrorKind.RATE_LIMIT,
                OpenAiPolishClient.errorForStatus(429).getKind());
        assertEquals(OpenAiPolishClient.ErrorKind.SERVER,
                OpenAiPolishClient.errorForStatus(503).getKind());
    }

    @Test
    public void cancelBeforeRequest_neverOpensConnection() {
        boolean[] opened = {false};
        OpenAiPolishClient client = new OpenAiPolishClient("gpt-4.1-mini", url -> {
            opened[0] = true;
            throw new IOException("must not open");
        });
        client.cancel();

        try {
            client.testConnection("dummy-key");
            fail("Expected cancellation");
        } catch (OpenAiPolishClient.OpenAiException exception) {
            assertEquals(OpenAiPolishClient.ErrorKind.CANCELLED, exception.getKind());
        }
        assertFalse(opened[0]);
    }

    @Test
    public void cancelDuringRead_closesStreamDisconnectsAndReturnsCancelled() throws Exception {
        BlockingInputStream responseStream = new BlockingInputStream();
        FakeHttpsConnection connection = new FakeHttpsConnection(responseStream);
        OpenAiPolishClient client = new OpenAiPolishClient(
                "gpt-4.1-mini", ignored -> connection);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<String> result = executor.submit(() -> client.polish(
                    "dummy-key",
                    "文章を整えてください。",
                    "入力です。"));

            assertTrue(responseStream.awaitReadStarted());
            client.cancel();

            try {
                result.get(2, TimeUnit.SECONDS);
                fail("Expected cancellation");
            } catch (ExecutionException exception) {
                OpenAiPolishClient.OpenAiException cause =
                        (OpenAiPolishClient.OpenAiException) exception.getCause();
                assertEquals(OpenAiPolishClient.ErrorKind.CANCELLED, cause.getKind());
            }
            assertTrue(responseStream.closed);
            assertTrue(connection.disconnected);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void polish_readsSuccessfulResponseAndDisconnects() throws Exception {
        String response = "{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":["
                + "{\"type\":\"output_text\",\"text\":\"整形済みです。\"}]}]}";
        FakeHttpsConnection connection = new FakeHttpsConnection(
                new ByteArrayInputStream(response.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        OpenAiPolishClient client = new OpenAiPolishClient(
                "gpt-4.1-mini", ignored -> connection);

        assertEquals("整形済みです。", client.polish(
                "dummy-key", "文章を整えてください。", "入力です。"));
        assertTrue(connection.disconnected);
        assertTrue(connection.requestBody.size() > 0);
    }

    @Test
    public void clientInstance_cannotBeReusedForAnotherRequest() throws Exception {
        String response = "{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":["
                + "{\"type\":\"output_text\",\"text\":\"OK\"}]}]}";
        OpenAiPolishClient client = new OpenAiPolishClient(
                "gpt-4.1-mini",
                ignored -> new FakeHttpsConnection(new ByteArrayInputStream(
                        response.getBytes(java.nio.charset.StandardCharsets.UTF_8))));

        client.testConnection("dummy-key");
        try {
            client.testConnection("dummy-key");
            fail("Expected one-shot rejection");
        } catch (OpenAiPolishClient.OpenAiException exception) {
            assertEquals(OpenAiPolishClient.ErrorKind.ALREADY_USED, exception.getKind());
        }
    }

    private static class FakeHttpsConnection extends HttpsURLConnection {
        private final InputStream inputStream;
        private final ByteArrayOutputStream requestBody = new ByteArrayOutputStream();
        private volatile boolean disconnected;

        FakeHttpsConnection(InputStream inputStream) throws IOException {
            super(new URL(OpenAiPolishClient.ENDPOINT));
            this.inputStream = inputStream;
        }

        @Override
        public void disconnect() {
            disconnected = true;
            try {
                inputStream.close();
            } catch (IOException ignored) {
                // Test double cleanup.
            }
        }

        @Override
        public boolean usingProxy() {
            return false;
        }

        @Override
        public void connect() {
            connected = true;
        }

        @Override
        public ByteArrayOutputStream getOutputStream() {
            return requestBody;
        }

        @Override
        public int getResponseCode() {
            return 200;
        }

        @Override
        public InputStream getInputStream() {
            return inputStream;
        }

        @Override
        public String getCipherSuite() {
            return "TLS_TEST";
        }

        @Override
        public Certificate[] getLocalCertificates() {
            return null;
        }

        @Override
        public Certificate[] getServerCertificates() throws SSLPeerUnverifiedException {
            return new Certificate[0];
        }

        @Override
        public Principal getPeerPrincipal() throws SSLPeerUnverifiedException {
            return null;
        }

        @Override
        public Principal getLocalPrincipal() {
            return null;
        }
    }

    private static final class BlockingInputStream extends InputStream {
        private final CountDownLatch readStarted = new CountDownLatch(1);
        private final CountDownLatch closedLatch = new CountDownLatch(1);
        private volatile boolean closed;

        @Override
        public int read() throws IOException {
            readStarted.countDown();
            try {
                if (!closedLatch.await(2, TimeUnit.SECONDS)) {
                    throw new IOException("test timeout");
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted");
            }
            throw new IOException("closed");
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            return read();
        }

        @Override
        public void close() {
            closed = true;
            closedLatch.countDown();
        }

        boolean awaitReadStarted() throws InterruptedException {
            return readStarted.await(2, TimeUnit.SECONDS);
        }
    }
}
