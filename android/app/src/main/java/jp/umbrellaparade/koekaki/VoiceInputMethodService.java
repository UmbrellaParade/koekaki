package jp.umbrellaparade.koekaki;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.LayoutInflater;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class VoiceInputMethodService extends InputMethodService {
    private static final int MAX_TRANSIENT_RETRIES = 3;
    private static final long SEGMENT_RESTART_DELAY_MS = 300L;
    private static final long STOP_RESULT_TIMEOUT_MS = 3_000L;
    private static final long POLISH_TIMEOUT_MS = 90_000L;
    private static final long IDLE_SESSION_TIMEOUT_MS = 60_000L;
    private static final long MAX_SESSION_DURATION_MS = 10L * 60L * 1_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final CommitOnceGate commitOnceGate = new CommitOnceGate();
    private final RequestEpochGate polishEpochGate = new RequestEpochGate();
    private final ExecutorService polishExecutor = Executors.newSingleThreadExecutor();

    private TextView statusView;
    private ProgressBar volumeView;
    private Button speakButton;
    private Button cancelButton;

    private SpeechRecognizer recognizer;
    private Runnable restartRunnable;
    private Runnable stopTimeoutRunnable;
    private Runnable sessionTimeoutRunnable;
    private Runnable idleTimeoutRunnable;
    private Runnable polishTimeoutRunnable;
    private Runnable autoReturnRunnable;
    private boolean sessionActive;
    private boolean stopRequested;
    private boolean segmentInFlight;
    private int transientRetries;
    private int inputGeneration;
    private int sessionGeneration;
    private int sessionFieldId;
    private int currentSelectionStart = -1;
    private int currentSelectionEnd = -1;
    private int sessionSelectionStart = -1;
    private int sessionSelectionEnd = -1;
    private String sessionPackageName;
    private InputConnection sessionConnection;
    private String transcript = "";
    private String polishTranscript = "";
    private String pendingPartial = "";
    private String latestPartial = "";
    private long activeToken;
    private SessionPhase phase = SessionPhase.IDLE;
    private volatile OpenAiPolishClient activePolishClient;
    private Future<?> activePolishFuture;

    private enum SessionPhase {
        IDLE,
        LISTENING,
        STOPPING,
        POLISHING
    }

    @Override
    public View onCreateInputView() {
        View root = LayoutInflater.from(this).inflate(R.layout.ime_voice, null, false);
        statusView = root.findViewById(R.id.ime_status);
        volumeView = root.findViewById(R.id.ime_volume);
        speakButton = root.findViewById(R.id.ime_speak);
        cancelButton = root.findViewById(R.id.ime_cancel);
        Button previousKeyboardButton = root.findViewById(R.id.ime_previous_keyboard);
        Button settingsButton = root.findViewById(R.id.ime_settings);

        speakButton.setOnClickListener(ignored -> {
            if (phase == SessionPhase.LISTENING) requestStop();
            else beginSession();
        });
        cancelButton.setOnClickListener(ignored -> cancelSession(true));
        previousKeyboardButton.setOnClickListener(ignored -> switchBackToUsualKeyboard());
        settingsButton.setOnClickListener(ignored -> openSetup());

        renderPhase();
        return root;
    }

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        cancelSession(false);
        inputGeneration += 1;
        currentSelectionStart = attribute == null ? -1 : attribute.initialSelStart;
        currentSelectionEnd = attribute == null ? -1 : attribute.initialSelEnd;
        super.onStartInput(attribute, restarting);
    }

    @Override
    public void onStartInputView(EditorInfo info, boolean restarting) {
        super.onStartInputView(info, restarting);
        updateEditorState();
    }

    @Override
    public void onFinishInputView(boolean finishingInput) {
        cancelSession(false);
        super.onFinishInputView(finishingInput);
    }

    @Override
    public void onFinishInput() {
        cancelSession(false);
        inputGeneration += 1;
        currentSelectionStart = -1;
        currentSelectionEnd = -1;
        super.onFinishInput();
    }

    @Override
    public void onUnbindInput() {
        cancelSession(false);
        inputGeneration += 1;
        currentSelectionStart = -1;
        currentSelectionEnd = -1;
        super.onUnbindInput();
    }

    @Override
    public void onUpdateSelection(
            int oldSelStart,
            int oldSelEnd,
            int newSelStart,
            int newSelEnd,
            int candidatesStart,
            int candidatesEnd) {
        super.onUpdateSelection(
                oldSelStart,
                oldSelEnd,
                newSelStart,
                newSelEnd,
                candidatesStart,
                candidatesEnd);
        currentSelectionStart = newSelStart;
        currentSelectionEnd = newSelEnd;
        if (!sessionActive) return;
        if (sessionSelectionStart < 0 || sessionSelectionEnd < 0) {
            sessionSelectionStart = newSelStart;
            sessionSelectionEnd = newSelEnd;
            return;
        }
        if (newSelStart != sessionSelectionStart || newSelEnd != sessionSelectionEnd) {
            cancelSession(false);
            setStatus(R.string.status_target_changed);
            updateEditorStateAfterDelay();
        }
    }

    @Override
    public void onWindowHidden() {
        cancelSession(false);
        super.onWindowHidden();
    }

    @Override
    public boolean onEvaluateFullscreenMode() {
        return false;
    }

    @Override
    public void onDestroy() {
        cancelSession(false);
        handler.removeCallbacksAndMessages(null);
        polishExecutor.shutdownNow();
        super.onDestroy();
    }

    private void beginSession() {
        if (phase != SessionPhase.IDLE) return;
        removeAutoReturn();
        EditorInfo editor = getCurrentInputEditorInfo();
        if (!SensitiveFieldPolicy.isSupported(editor)) {
            setStatus(R.string.status_unsupported_field);
            return;
        }
        if (SensitiveFieldPolicy.isSensitive(editor)) {
            setStatus(R.string.status_sensitive);
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            setStatus(R.string.status_permission_required);
            openSetup();
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            setStatus(R.string.status_recognizer_unavailable);
            return;
        }
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            setStatus(R.string.status_target_changed);
            return;
        }

        sessionActive = true;
        phase = SessionPhase.LISTENING;
        stopRequested = false;
        segmentInFlight = false;
        transientRetries = 0;
        transcript = "";
        polishTranscript = "";
        pendingPartial = "";
        latestPartial = "";
        sessionGeneration = inputGeneration;
        sessionPackageName = editor.packageName == null ? "" : editor.packageName;
        sessionFieldId = editor.fieldId;
        sessionConnection = connection;
        sessionSelectionStart = currentSelectionStart;
        sessionSelectionEnd = currentSelectionEnd;
        commitOnceGate.start(sessionGeneration);
        activeToken += 1;
        long token = activeToken;

        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new SessionListener(token));
        } catch (RuntimeException exception) {
            recognizer = null;
            finishWithoutCommit(R.string.status_recognizer_unavailable);
            return;
        }
        renderControlsForPhase();
        sessionTimeoutRunnable = () -> {
            if (isCurrentSession(token)) requestStop();
        };
        handler.postDelayed(sessionTimeoutRunnable, MAX_SESSION_DURATION_MS);
        resetIdleTimeout(token);
        startSegment(token);
    }

    @SuppressLint("MissingPermission")
    private void startSegment(long token) {
        if (!isCurrentRecognitionSession(token)
                || phase != SessionPhase.LISTENING
                || stopRequested
                || segmentInFlight
                || recognizer == null) return;

        latestPartial = "";
        setStatus(R.string.status_preparing);
        setVolumeVisible(true);
        segmentInFlight = true;

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.JAPAN.toLanguageTag());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ recognizers can return a punctuation-formatted first hypothesis and
            // the unformatted text second. Implementations may ignore this optional hint.
            intent.putExtra(
                    RecognizerIntent.EXTRA_ENABLE_FORMATTING,
                    RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 2);
        } else {
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        }
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1_500L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1_800L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3_000L);

        try {
            recognizer.startListening(intent);
        } catch (RuntimeException exception) {
            segmentInFlight = false;
            handleRecognitionError(token, SpeechRecognizer.ERROR_CLIENT);
        }
    }

    private void requestStop() {
        if (!sessionActive || phase != SessionPhase.LISTENING || stopRequested) return;
        phase = SessionPhase.STOPPING;
        stopRequested = true;
        removeRestart();
        renderControlsForPhase();
        setStatus(R.string.status_processing);
        setVolumeVisible(false);

        long token = activeToken;
        if (!segmentInFlight || recognizer == null) {
            finalizeTranscriptForOutput(token, false);
            return;
        }

        try {
            recognizer.stopListening();
        } catch (RuntimeException exception) {
            finalizeTranscriptForOutput(token, true);
            return;
        }

        stopTimeoutRunnable = () -> {
            if (!isCurrentRecognitionSession(token)) return;
            finalizeTranscriptForOutput(token, true);
        };
        handler.postDelayed(stopTimeoutRunnable, STOP_RESULT_TIMEOUT_MS);
    }

    private void handleRecognitionResult(long token, Bundle results) {
        if (!isCurrentRecognitionSession(token)) return;
        segmentInFlight = false;
        removeStopTimeout();

        String finalText = RecognitionResultSelector.select(firstResult(results), latestPartial);
        boolean capturedText = !pendingPartial.trim().isEmpty() || !finalText.trim().isEmpty();
        flushPendingPartial();
        appendRecognizedSegment(finalText);
        latestPartial = "";
        transientRetries = 0;

        if (stopRequested) {
            finalizeTranscriptForOutput(token, false);
        } else {
            resetIdleTimeout(token);
            scheduleRestart(
                    token,
                    SEGMENT_RESTART_DELAY_MS,
                    capturedText
                            ? R.string.status_segment_saved
                            : R.string.status_recognition_retrying);
        }
    }

    private void handleRecognitionError(long token, int error) {
        if (!isCurrentRecognitionSession(token)) return;
        segmentInFlight = false;
        removeStopTimeout();

        if (stopRequested) {
            finalizeTranscriptForOutput(token, true);
            return;
        }

        if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
            // Keep the provisional hypothesis separate until the next final result. This avoids
            // both losing a spoken phrase and prematurely committing a hypothesis that may be
            // covered by the next recognizer result.
            stashLatestPartial();
            transientRetries = 0;
            scheduleRestart(token, 450L, R.string.status_recognition_retrying);
            return;
        }

        if (error == SpeechRecognizer.ERROR_NETWORK
                || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
                || error == SpeechRecognizer.ERROR_SERVER
                || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {
            transientRetries += 1;
            if (transientRetries <= MAX_TRANSIENT_RETRIES) {
                stashLatestPartial();
                long delay = 500L * transientRetries;
                scheduleRestart(token, delay, R.string.status_recognition_retrying);
                return;
            }
        }

        int message = recognitionErrorMessage(error);
        if (!transcript.trim().isEmpty()
                || !pendingPartial.trim().isEmpty()
                || !latestPartial.trim().isEmpty()) {
            finalizeTranscriptForOutput(token, true, R.string.status_inserted_after_error);
        } else {
            finishWithoutCommit(message);
        }
    }

    private void scheduleRestart(long token, long delayMillis, int statusResource) {
        if (!isCurrentRecognitionSession(token) || phase != SessionPhase.LISTENING) return;
        removeRestart();
        setStatus(statusResource);
        setVolumeVisible(false);
        restartRunnable = () -> startSegment(token);
        handler.postDelayed(restartRunnable, delayMillis);
    }

    private void finalizeTranscriptForOutput(long token, boolean includePartial) {
        finalizeTranscriptForOutput(token, includePartial, R.string.status_inserted);
    }

    private void finalizeTranscriptForOutput(
            long token,
            boolean includePartial,
            int successMessage) {
        if (!isCurrentRecognitionSession(token)) return;
        flushPendingPartial();
        if (includePartial) appendRecognizedSegment(latestPartial);
        String rawText = transcript.trim();
        String structuredText = polishTranscript.trim();
        if (structuredText.isEmpty()) structuredText = rawText;

        if (rawText.isEmpty()) {
            finishWithoutCommit(R.string.status_no_speech);
            return;
        }
        if (!isOriginalTargetStillActive()) {
            finishWithoutCommit(R.string.status_target_changed);
            return;
        }

        SharedPreferences settings = preferences();
        String modeId = KoekakiPrompts.findMode(settings.getString(
                KoekakiSettings.KEY_ACTIVE_MODE_ID,
                KoekakiSettings.DEFAULT_MODE_ID)).getId();
        boolean aiEnabled = settings.getBoolean(
                KoekakiSettings.KEY_AI_POLISH_ENABLED,
                KoekakiSettings.DEFAULT_AI_POLISH_ENABLED);
        if (!aiEnabled || KoekakiPrompts.isRawMode(modeId)) {
            commitTextForSession(token, rawText, successMessage);
            return;
        }

        String fallbackText = ProsePunctuationGuard.apply(rawText, modeId);

        SecureApiKeyStore keyStore = new SecureApiKeyStore(this);
        if (!keyStore.hasSavedKey()) {
            commitTextForSession(
                    token,
                    fallbackText,
                    fallbackStatus(successMessage, true));
            return;
        }

        String model = settings.getString(
                KoekakiSettings.KEY_OPENAI_MODEL,
                KoekakiSettings.DEFAULT_OPENAI_MODEL);
        String instructions = KoekakiPrompts.buildPolishSystemPrompt(
                modeId,
                settings.getString(KoekakiSettings.KEY_USER_DICTIONARY, ""),
                settings.getString(KoekakiSettings.KEY_STYLE_SAMPLE, ""),
                settings.getBoolean(
                        KoekakiSettings.KEY_USE_BUILTIN_TERMS,
                        KoekakiSettings.DEFAULT_USE_BUILTIN_TERMS));
        String input = KoekakiPrompts.buildPolishInput(structuredText);
        final OpenAiPolishClient client;
        try {
            client = new OpenAiPolishClient(model);
        } catch (IllegalArgumentException exception) {
            commitTextForSession(
                    token,
                    fallbackText,
                    fallbackStatus(successMessage, false));
            return;
        }

        sessionSelectionStart = currentSelectionStart;
        sessionSelectionEnd = currentSelectionEnd;
        phase = SessionPhase.POLISHING;
        stopRecognitionKeepTarget();
        setStatus(R.string.status_ai_polishing);
        renderControlsForPhase();

        long requestEpoch = polishEpochGate.begin();
        activePolishClient = client;
        try {
            activePolishFuture = polishExecutor.submit(() -> {
                String polishedText = "";
                boolean succeeded = false;
                try {
                    String apiKey = keyStore.load();
                    if (apiKey != null) {
                        polishedText = client.polish(apiKey, instructions, input);
                        succeeded = !polishedText.trim().isEmpty();
                    }
                } catch (SecureApiKeyStore.SecureStoreException
                         | OpenAiPolishClient.OpenAiException exception) {
                    // The original transcript remains available for the safe fallback below.
                } catch (RuntimeException exception) {
                    // No exception details, transcript, response, or credential are logged.
                }

                String result = polishedText;
                boolean requestSucceeded = succeeded;
                handler.post(() -> handlePolishResult(
                        token,
                        requestEpoch,
                        client,
                        fallbackText,
                        result,
                        requestSucceeded,
                        successMessage));
            });
            polishTimeoutRunnable = () -> handlePolishTimeout(
                    token,
                    requestEpoch,
                    client,
                    fallbackText,
                    successMessage);
            handler.postDelayed(polishTimeoutRunnable, POLISH_TIMEOUT_MS);
        } catch (RuntimeException exception) {
            polishEpochGate.cancel();
            activePolishClient = null;
            commitTextForSession(
                    token,
                    fallbackText,
                    fallbackStatus(successMessage, false));
        }
    }

    private void handlePolishResult(
            long token,
            long requestEpoch,
            OpenAiPolishClient client,
            String fallbackText,
            String polishedText,
            boolean succeeded,
            int successMessage) {
        if (!isCurrentSession(token)
                || phase != SessionPhase.POLISHING
                || activePolishClient != client
                || !polishEpochGate.tryClaim(requestEpoch)) return;
        removePolishTimeout();
        activePolishClient = null;
        activePolishFuture = null;

        if (!isOriginalTargetStillActive()) {
            finishWithoutCommit(R.string.status_target_changed);
            return;
        }

        String output = succeeded ? polishedText.trim() : fallbackText;
        int message;
        if (!succeeded) {
            message = fallbackStatus(successMessage, false);
        } else if (successMessage == R.string.status_inserted_after_error) {
            message = R.string.status_inserted_with_ai_after_recognition_error;
        } else {
            message = R.string.status_inserted_with_ai;
        }
        commitTextForSession(token, output, message);
    }

    private void handlePolishTimeout(
            long token,
            long requestEpoch,
            OpenAiPolishClient client,
            String fallbackText,
            int successMessage) {
        polishTimeoutRunnable = null;
        if (!isCurrentSession(token)
                || phase != SessionPhase.POLISHING
                || activePolishClient != client
                || !polishEpochGate.tryClaim(requestEpoch)) return;
        activePolishClient = null;
        client.cancel();
        Future<?> future = activePolishFuture;
        activePolishFuture = null;
        if (future != null) future.cancel(true);
        if (!isOriginalTargetStillActive()) {
            finishWithoutCommit(R.string.status_target_changed);
            return;
        }
        commitTextForSession(
                token,
                fallbackText,
                fallbackStatus(successMessage, false));
    }

    private void commitTextForSession(long token, String text, int successMessage) {
        if (!isCurrentSession(token) || !isOriginalTargetStillActive()) {
            finishWithoutCommit(R.string.status_target_changed);
            return;
        }
        if (!commitOnceGate.tryClaim(inputGeneration)) {
            finishWithoutCommit(R.string.status_target_changed);
            return;
        }

        InputConnection connection = getCurrentInputConnection();
        boolean committed = false;
        try {
            committed = connection != null
                    && connection == sessionConnection
                    && connection.commitText(text, 1);
        } catch (RuntimeException ignored) {
            // A dead editor connection is treated as a changed target and is never retried.
        }
        boolean shouldReturn = committed && preferences().getBoolean(
                KoekakiSettings.KEY_AUTO_RETURN_KEYBOARD,
                KoekakiSettings.DEFAULT_AUTO_RETURN_KEYBOARD);
        clearSession();

        if (!committed) {
            setStatus(R.string.status_target_changed);
            updateEditorStateAfterDelay();
            return;
        }

        setStatus(successMessage);
        if (shouldShowPersistentNotice(successMessage)) {
            Toast.makeText(this, successMessage, Toast.LENGTH_LONG).show();
        }
        if (shouldReturn) {
            int returnGeneration = inputGeneration;
            autoReturnRunnable = () -> {
                autoReturnRunnable = null;
                if (inputGeneration == returnGeneration && isInputViewShown()) {
                    switchBackToUsualKeyboard();
                }
            };
            handler.postDelayed(autoReturnRunnable, 250L);
        }
        else updateEditorStateAfterDelay();
    }

    private boolean isOriginalTargetStillActive() {
        if (sessionGeneration != inputGeneration) return false;
        if (sessionConnection == null || getCurrentInputConnection() != sessionConnection) return false;
        EditorInfo current = getCurrentInputEditorInfo();
        if (!SensitiveFieldPolicy.isSupported(current) || SensitiveFieldPolicy.isSensitive(current)) return false;
        String currentPackage = current.packageName == null ? "" : current.packageName;
        return sessionFieldId == current.fieldId && Objects.equals(sessionPackageName, currentPackage);
    }

    private void cancelSession(boolean announce) {
        boolean wasActive = sessionActive;
        clearSession();
        if (announce && wasActive) setStatus(R.string.status_cancelled);
        else if (announce) updateEditorState();
    }

    private void finishWithoutCommit(int messageResource) {
        clearSession();
        setStatus(messageResource);
        updateEditorStateAfterDelay();
    }

    private void clearSession() {
        sessionActive = false;
        phase = SessionPhase.IDLE;
        stopRequested = false;
        segmentInFlight = false;
        transientRetries = 0;
        activeToken += 1;
        transcript = "";
        polishTranscript = "";
        pendingPartial = "";
        latestPartial = "";
        sessionPackageName = null;
        sessionConnection = null;
        sessionSelectionStart = -1;
        sessionSelectionEnd = -1;
        commitOnceGate.invalidate();
        polishEpochGate.cancel();
        OpenAiPolishClient polishClient = activePolishClient;
        activePolishClient = null;
        if (polishClient != null) polishClient.cancel();
        Future<?> polishFuture = activePolishFuture;
        activePolishFuture = null;
        if (polishFuture != null) polishFuture.cancel(true);
        removeRestart();
        removeStopTimeout();
        removeSessionTimeout();
        removeIdleTimeout();
        removePolishTimeout();
        removeAutoReturn();
        destroyRecognizer();
        renderControlsForPhase();
        setVolumeVisible(false);
    }

    private void stopRecognitionKeepTarget() {
        stopRequested = false;
        segmentInFlight = false;
        removeRestart();
        removeStopTimeout();
        removeSessionTimeout();
        removeIdleTimeout();
        destroyRecognizer();
        setVolumeVisible(false);
    }

    private void destroyRecognizer() {
        SpeechRecognizer activeRecognizer = recognizer;
        recognizer = null;
        if (activeRecognizer == null) return;
        try {
            activeRecognizer.cancel();
        } catch (RuntimeException ignored) {
            // The recognizer may already be disconnected. Nothing is persisted.
        }
        try {
            activeRecognizer.destroy();
        } catch (RuntimeException ignored) {
            // Some vendor recognizers throw while disconnecting; the session is already invalid.
        }
    }

    private void switchBackToUsualKeyboard() {
        cancelSession(false);
        if (switchToPreviousInputMethod()) return;
        InputMethodManager manager = getSystemService(InputMethodManager.class);
        if (manager != null) manager.showInputMethodPicker();
    }

    private void openSetup() {
        cancelSession(false);
        Intent intent = new Intent(this, SetupActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(intent);
    }

    private void updateEditorState() {
        if (sessionActive || statusView == null || speakButton == null) return;
        EditorInfo editor = getCurrentInputEditorInfo();
        if (!SensitiveFieldPolicy.isSupported(editor)) {
            speakButton.setEnabled(false);
            setStatus(R.string.status_unsupported_field);
        } else if (SensitiveFieldPolicy.isSensitive(editor)) {
            speakButton.setEnabled(false);
            setStatus(R.string.status_sensitive);
        } else {
            speakButton.setEnabled(true);
            SharedPreferences settings = preferences();
            String modeId = KoekakiPrompts.findMode(settings.getString(
                    KoekakiSettings.KEY_ACTIVE_MODE_ID,
                    KoekakiSettings.DEFAULT_MODE_ID)).getId();
            boolean aiEnabled = settings.getBoolean(
                    KoekakiSettings.KEY_AI_POLISH_ENABLED,
                    KoekakiSettings.DEFAULT_AI_POLISH_ENABLED);
            if (!aiEnabled || KoekakiPrompts.isRawMode(modeId)) {
                setStatus(R.string.status_ready_without_ai);
            } else if (!new SecureApiKeyStore(this).hasSavedKey()) {
                setStatus(R.string.status_ready_without_ai_key);
            } else {
                setStatus(R.string.status_ready_with_ai);
            }
        }
    }

    private void renderPhase() {
        if (statusView == null || speakButton == null) return;
        renderControlsForPhase();
        if (phase == SessionPhase.POLISHING) {
            setStatus(R.string.status_ai_polishing);
            setVolumeVisible(false);
        } else if (phase == SessionPhase.STOPPING) {
            setStatus(R.string.status_processing);
            setVolumeVisible(false);
        } else if (phase == SessionPhase.LISTENING) {
            setStatus(R.string.status_listening);
            setVolumeVisible(true);
        } else {
            updateEditorState();
        }
    }

    private void updateEditorStateAfterDelay() {
        handler.postDelayed(this::updateEditorState, 1_200L);
    }

    private void renderControlsForPhase() {
        boolean idle = phase == SessionPhase.IDLE;
        boolean listening = phase == SessionPhase.LISTENING;
        if (speakButton != null) {
            speakButton.setText(phase == SessionPhase.POLISHING
                    ? R.string.action_processing
                    : idle ? R.string.action_speak : R.string.action_stop);
            speakButton.setEnabled(idle || listening);
        }
        if (cancelButton != null) cancelButton.setEnabled(!idle);
    }

    private void setStatus(int resource) {
        if (statusView != null) statusView.setText(resource);
    }

    private void setVolumeVisible(boolean visible) {
        if (volumeView == null) return;
        volumeView.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        if (!visible) volumeView.setProgress(0);
    }

    private void setVolume(float rmsDb) {
        if (volumeView == null) return;
        int progress = Math.max(0, Math.min(100, Math.round((rmsDb + 2f) * 7f)));
        volumeView.setProgress(progress);
    }

    private boolean isCurrentSession(long token) {
        return sessionActive && token == activeToken;
    }

    private boolean isCurrentRecognitionSession(long token) {
        return isCurrentSession(token)
                && (phase == SessionPhase.LISTENING || phase == SessionPhase.STOPPING);
    }

    private void removeRestart() {
        if (restartRunnable == null) return;
        handler.removeCallbacks(restartRunnable);
        restartRunnable = null;
    }

    private void removeStopTimeout() {
        if (stopTimeoutRunnable == null) return;
        handler.removeCallbacks(stopTimeoutRunnable);
        stopTimeoutRunnable = null;
    }

    private void removeSessionTimeout() {
        if (sessionTimeoutRunnable == null) return;
        handler.removeCallbacks(sessionTimeoutRunnable);
        sessionTimeoutRunnable = null;
    }

    private void resetIdleTimeout(long token) {
        removeIdleTimeout();
        idleTimeoutRunnable = () -> {
            if (isCurrentSession(token)) requestStop();
        };
        handler.postDelayed(idleTimeoutRunnable, IDLE_SESSION_TIMEOUT_MS);
    }

    private void removeIdleTimeout() {
        if (idleTimeoutRunnable == null) return;
        handler.removeCallbacks(idleTimeoutRunnable);
        idleTimeoutRunnable = null;
    }

    private void removePolishTimeout() {
        if (polishTimeoutRunnable == null) return;
        handler.removeCallbacks(polishTimeoutRunnable);
        polishTimeoutRunnable = null;
    }

    private void removeAutoReturn() {
        if (autoReturnRunnable == null) return;
        handler.removeCallbacks(autoReturnRunnable);
        autoReturnRunnable = null;
    }

    private void appendRecognizedSegment(String segment) {
        transcript = TranscriptAccumulator.append(transcript, segment);
        polishTranscript = TranscriptAccumulator.appendWithBoundary(polishTranscript, segment);
    }

    private void stashLatestPartial() {
        pendingPartial = TranscriptAccumulator.append(pendingPartial, latestPartial);
        latestPartial = "";
    }

    private void flushPendingPartial() {
        appendRecognizedSegment(pendingPartial);
        pendingPartial = "";
    }

    private static boolean shouldShowPersistentNotice(int messageResource) {
        return messageResource == R.string.status_inserted_with_ai
                || messageResource == R.string.status_inserted_after_error
                || messageResource == R.string.status_inserted_with_ai_after_recognition_error
                || messageResource == R.string.status_inserted_without_ai
                || messageResource == R.string.status_inserted_without_ai_key
                || messageResource == R.string.status_inserted_after_error_without_ai
                || messageResource == R.string.status_inserted_after_error_without_ai_key;
    }

    private static int fallbackStatus(int successMessage, boolean keyMissing) {
        if (successMessage == R.string.status_inserted_after_error) {
            return keyMissing
                    ? R.string.status_inserted_after_error_without_ai_key
                    : R.string.status_inserted_after_error_without_ai;
        }
        return keyMissing
                ? R.string.status_inserted_without_ai_key
                : R.string.status_inserted_without_ai;
    }

    private SharedPreferences preferences() {
        return getSharedPreferences(KoekakiSettings.PREFERENCES_NAME, MODE_PRIVATE);
    }

    private static String firstResult(Bundle results) {
        if (results == null) return "";
        ArrayList<String> values = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (values == null || values.isEmpty() || values.get(0) == null) return "";
        return values.get(0).trim();
    }

    private static int recognitionErrorMessage(int error) {
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
            return R.string.status_permission_required;
        }
        if (error == SpeechRecognizer.ERROR_NETWORK
                || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
                || error == SpeechRecognizer.ERROR_SERVER) {
            return R.string.status_network_error;
        }
        if (error == SpeechRecognizer.ERROR_AUDIO) return R.string.status_audio_error;
        if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) return R.string.status_recognizer_busy;
        return R.string.status_recognition_error;
    }

    private final class SessionListener implements RecognitionListener {
        private final long token;

        private SessionListener(long token) {
            this.token = token;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (!isCurrentRecognitionSession(token) || phase != SessionPhase.LISTENING) return;
            setStatus(R.string.status_listening);
        }

        @Override
        public void onBeginningOfSpeech() {
            if (!isCurrentRecognitionSession(token) || phase != SessionPhase.LISTENING) return;
            resetIdleTimeout(token);
            setStatus(R.string.status_listening);
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (isCurrentRecognitionSession(token) && phase == SessionPhase.LISTENING) {
                setVolume(rmsdB);
            }
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
            // Audio bytes are deliberately not retained or logged.
        }

        @Override
        public void onEndOfSpeech() {
            if (!isCurrentRecognitionSession(token) || phase != SessionPhase.LISTENING) return;
            setStatus(R.string.status_processing);
            setVolumeVisible(false);
        }

        @Override
        public void onError(int error) {
            handleRecognitionError(token, error);
        }

        @Override
        public void onResults(Bundle results) {
            handleRecognitionResult(token, results);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (!isCurrentRecognitionSession(token)) return;
            latestPartial = firstResult(partialResults);
            if (!latestPartial.isEmpty()) resetIdleTimeout(token);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
            // Reserved by Android. No content is logged or persisted.
        }
    }
}
