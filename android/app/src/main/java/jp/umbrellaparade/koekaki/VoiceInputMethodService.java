package jp.umbrellaparade.koekaki;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.inputmethodservice.InputMethodService;
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

import java.util.ArrayList;
import java.util.Locale;
import java.util.Objects;

public final class VoiceInputMethodService extends InputMethodService {
    private static final String PREFERENCES = "koekaki_settings";
    private static final String AUTO_RETURN_KEY = "auto_return_keyboard";
    private static final int MAX_TRANSIENT_RETRIES = 3;
    private static final long SEGMENT_RESTART_DELAY_MS = 300L;
    private static final long STOP_RESULT_TIMEOUT_MS = 3_000L;
    private static final long IDLE_SESSION_TIMEOUT_MS = 60_000L;
    private static final long MAX_SESSION_DURATION_MS = 10L * 60L * 1_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final CommitOnceGate commitOnceGate = new CommitOnceGate();

    private TextView statusView;
    private ProgressBar volumeView;
    private Button speakButton;
    private Button cancelButton;

    private SpeechRecognizer recognizer;
    private Runnable restartRunnable;
    private Runnable stopTimeoutRunnable;
    private Runnable sessionTimeoutRunnable;
    private Runnable idleTimeoutRunnable;
    private boolean sessionActive;
    private boolean stopRequested;
    private boolean segmentInFlight;
    private int transientRetries;
    private int inputGeneration;
    private int sessionGeneration;
    private int sessionFieldId;
    private String sessionPackageName;
    private InputConnection sessionConnection;
    private String transcript = "";
    private String latestPartial = "";
    private long activeToken;

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
            if (sessionActive) requestStop();
            else beginSession();
        });
        cancelButton.setOnClickListener(ignored -> cancelSession(true));
        previousKeyboardButton.setOnClickListener(ignored -> switchBackToUsualKeyboard());
        settingsButton.setOnClickListener(ignored -> openSetup());

        updateEditorState();
        return root;
    }

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        cancelSession(false);
        inputGeneration += 1;
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
        super.onFinishInput();
    }

    @Override
    public void onUnbindInput() {
        cancelSession(false);
        inputGeneration += 1;
        super.onUnbindInput();
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
        super.onDestroy();
    }

    private void beginSession() {
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
        stopRequested = false;
        segmentInFlight = false;
        transientRetries = 0;
        transcript = "";
        latestPartial = "";
        sessionGeneration = inputGeneration;
        sessionPackageName = editor.packageName == null ? "" : editor.packageName;
        sessionFieldId = editor.fieldId;
        sessionConnection = connection;
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
        setControlsRecording(true);
        sessionTimeoutRunnable = () -> {
            if (isCurrentSession(token)) requestStop();
        };
        handler.postDelayed(sessionTimeoutRunnable, MAX_SESSION_DURATION_MS);
        resetIdleTimeout(token);
        startSegment(token);
    }

    @SuppressLint("MissingPermission")
    private void startSegment(long token) {
        if (!isCurrentSession(token) || stopRequested || segmentInFlight || recognizer == null) return;

        latestPartial = "";
        setStatus(R.string.status_preparing);
        setVolumeVisible(true);
        segmentInFlight = true;

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.JAPAN.toLanguageTag());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
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
        if (!sessionActive || stopRequested) return;
        stopRequested = true;
        removeRestart();
        setStatus(R.string.status_processing);
        setVolumeVisible(false);

        long token = activeToken;
        if (!segmentInFlight || recognizer == null) {
            finishAndCommit(token, false);
            return;
        }

        try {
            recognizer.stopListening();
        } catch (RuntimeException exception) {
            finishAndCommit(token, true);
            return;
        }

        stopTimeoutRunnable = () -> {
            if (!isCurrentSession(token)) return;
            finishAndCommit(token, true);
        };
        handler.postDelayed(stopTimeoutRunnable, STOP_RESULT_TIMEOUT_MS);
    }

    private void handleRecognitionResult(long token, Bundle results) {
        if (!isCurrentSession(token)) return;
        segmentInFlight = false;
        removeStopTimeout();

        String finalText = firstResult(results);
        if (finalText.trim().isEmpty()) finalText = latestPartial;
        transcript = TranscriptAccumulator.append(transcript, finalText);
        latestPartial = "";
        transientRetries = 0;

        if (stopRequested) {
            finishAndCommit(token, false);
        } else {
            resetIdleTimeout(token);
            scheduleRestart(token, SEGMENT_RESTART_DELAY_MS);
        }
    }

    private void handleRecognitionError(long token, int error) {
        if (!isCurrentSession(token)) return;
        segmentInFlight = false;
        removeStopTimeout();

        if (stopRequested) {
            finishAndCommit(token, true);
            return;
        }

        preserveLatestPartial();

        if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
            transientRetries = 0;
            scheduleRestart(token, 450L);
            return;
        }

        if (error == SpeechRecognizer.ERROR_NETWORK
                || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
                || error == SpeechRecognizer.ERROR_SERVER
                || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {
            transientRetries += 1;
            if (transientRetries <= MAX_TRANSIENT_RETRIES) {
                long delay = 500L * transientRetries;
                scheduleRestart(token, delay);
                return;
            }
        }

        int message = recognitionErrorMessage(error);
        if (!transcript.trim().isEmpty() || !latestPartial.trim().isEmpty()) {
            finishAndCommit(token, true, R.string.status_inserted_after_error);
        } else {
            finishWithoutCommit(message);
        }
    }

    private void scheduleRestart(long token, long delayMillis) {
        removeRestart();
        setStatus(R.string.status_preparing);
        setVolumeVisible(false);
        restartRunnable = () -> startSegment(token);
        handler.postDelayed(restartRunnable, delayMillis);
    }

    private void finishAndCommit(long token, boolean includePartial) {
        finishAndCommit(token, includePartial, R.string.status_inserted);
    }

    private void finishAndCommit(long token, boolean includePartial, int successMessage) {
        if (!isCurrentSession(token)) return;
        if (includePartial) transcript = TranscriptAccumulator.append(transcript, latestPartial);
        String finalText = transcript.trim();

        if (finalText.isEmpty()) {
            finishWithoutCommit(R.string.status_no_speech);
            return;
        }
        if (!isOriginalTargetStillActive()) {
            finishWithoutCommit(R.string.status_target_changed);
            return;
        }
        if (!commitOnceGate.tryClaim(inputGeneration)) {
            finishWithoutCommit(R.string.status_target_changed);
            return;
        }

        InputConnection connection = getCurrentInputConnection();
        boolean committed = connection != null
                && connection == sessionConnection
                && connection.commitText(finalText, 1);
        boolean shouldReturn = committed && preferences().getBoolean(AUTO_RETURN_KEY, false);
        clearSession();

        if (!committed) {
            setStatus(R.string.status_target_changed);
            updateEditorStateAfterDelay();
            return;
        }

        setStatus(successMessage);
        if (shouldReturn) handler.postDelayed(this::switchBackToUsualKeyboard, 250L);
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
        stopRequested = false;
        segmentInFlight = false;
        transientRetries = 0;
        activeToken += 1;
        transcript = "";
        latestPartial = "";
        sessionPackageName = null;
        sessionConnection = null;
        commitOnceGate.invalidate();
        removeRestart();
        removeStopTimeout();
        removeSessionTimeout();
        removeIdleTimeout();

        SpeechRecognizer activeRecognizer = recognizer;
        recognizer = null;
        if (activeRecognizer != null) {
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
        setControlsRecording(false);
        setVolumeVisible(false);
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
            setStatus(R.string.status_ready);
        }
    }

    private void updateEditorStateAfterDelay() {
        handler.postDelayed(this::updateEditorState, 1_200L);
    }

    private void setControlsRecording(boolean recording) {
        if (speakButton != null) {
            speakButton.setEnabled(true);
            speakButton.setText(recording ? R.string.action_stop : R.string.action_speak);
        }
        if (cancelButton != null) cancelButton.setEnabled(recording);
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

    private void preserveLatestPartial() {
        transcript = TranscriptAccumulator.append(transcript, latestPartial);
        latestPartial = "";
    }

    private SharedPreferences preferences() {
        return getSharedPreferences(PREFERENCES, MODE_PRIVATE);
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
            if (!isCurrentSession(token)) return;
            setStatus(R.string.status_listening);
        }

        @Override
        public void onBeginningOfSpeech() {
            if (!isCurrentSession(token)) return;
            resetIdleTimeout(token);
            setStatus(R.string.status_listening);
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (isCurrentSession(token)) setVolume(rmsdB);
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
            // Audio bytes are deliberately not retained or logged.
        }

        @Override
        public void onEndOfSpeech() {
            if (!isCurrentSession(token)) return;
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
            if (!isCurrentSession(token)) return;
            latestPartial = firstResult(partialResults);
            if (!latestPartial.isEmpty()) resetIdleTimeout(token);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
            // Reserved by Android. No content is logged or persisted.
        }
    }
}
