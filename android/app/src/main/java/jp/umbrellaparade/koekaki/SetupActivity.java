package jp.umbrellaparade.koekaki;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Launcher screen used to finish the one-time setup for the Koekaki input method.
 *
 * <p>This activity intentionally never reads or logs text entered in the test field. The field
 * exists only to give users a safe place to confirm that the IME can commit text before they open
 * Codex, Claude, LINE, or another app.</p>
 */
public final class SetupActivity extends Activity {
    private static final int REQUEST_RECORD_AUDIO = 1001;

    private TextView microphoneStatus;
    private TextView imeEnabledStatus;
    private TextView imeSelectedStatus;
    private Button microphoneButton;
    private TextView apiKeyStatus;
    private TextView openAiTestStatus;
    private EditText apiKeyInput;
    private EditText modelInput;
    private EditText dictionaryInput;
    private EditText styleSampleInput;
    private CheckBox aiPolishEnabled;
    private CheckBox builtinTermsEnabled;
    private Spinner polishMode;
    private Button deleteApiKeyButton;
    private Button testOpenAiButton;
    private SharedPreferences preferences;
    private SecureApiKeyStore apiKeyStore;
    private boolean microphonePermissionRequested;
    private final ExecutorService openAiExecutor = Executors.newSingleThreadExecutor();
    private final RequestEpochGate connectionTestGate = new RequestEpochGate();
    private volatile OpenAiPolishClient activeTestClient;
    private Future<?> activeTestFuture;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        setContentView(R.layout.activity_setup);

        preferences = getSharedPreferences(KoekakiSettings.PREFERENCES_NAME, MODE_PRIVATE);
        apiKeyStore = new SecureApiKeyStore(this);
        microphoneStatus = findViewById(R.id.status_microphone);
        imeEnabledStatus = findViewById(R.id.status_ime_enabled);
        imeSelectedStatus = findViewById(R.id.status_ime_selected);
        microphoneButton = findViewById(R.id.button_microphone_permission);
        apiKeyStatus = findViewById(R.id.status_api_key);
        openAiTestStatus = findViewById(R.id.status_openai_test);
        apiKeyInput = findViewById(R.id.edit_api_key);
        modelInput = findViewById(R.id.edit_openai_model);
        dictionaryInput = findViewById(R.id.edit_user_dictionary);
        styleSampleInput = findViewById(R.id.edit_style_sample);
        aiPolishEnabled = findViewById(R.id.checkbox_ai_polish);
        builtinTermsEnabled = findViewById(R.id.checkbox_builtin_terms);
        polishMode = findViewById(R.id.spinner_polish_mode);
        deleteApiKeyButton = findViewById(R.id.button_delete_api_key);
        testOpenAiButton = findViewById(R.id.button_test_openai);

        microphoneButton.setOnClickListener(view -> handleMicrophonePermission());
        findViewById(R.id.button_open_ime_settings).setOnClickListener(
                view -> openInputMethodSettings());
        findViewById(R.id.button_choose_input_method).setOnClickListener(
                view -> showInputMethodPicker());
        findViewById(R.id.button_paste_api_key).setOnClickListener(
                view -> pasteApiKeyFromClipboard());
        findViewById(R.id.button_save_api_key).setOnClickListener(
                view -> saveApiKey());
        deleteApiKeyButton.setOnClickListener(view -> confirmDeleteApiKey());
        findViewById(R.id.button_save_ai_settings).setOnClickListener(
                view -> saveAiSettings(true));
        testOpenAiButton.setOnClickListener(view -> testOpenAiConnection());

        CheckBox autoReturnKeyboard = findViewById(R.id.checkbox_auto_return_keyboard);
        autoReturnKeyboard.setChecked(
                preferences.getBoolean(
                        KoekakiSettings.KEY_AUTO_RETURN_KEYBOARD,
                        KoekakiSettings.DEFAULT_AUTO_RETURN_KEYBOARD));
        autoReturnKeyboard.setOnCheckedChangeListener((buttonView, isChecked) ->
                preferences.edit()
                        .putBoolean(KoekakiSettings.KEY_AUTO_RETURN_KEYBOARD, isChecked)
                        .apply());

        loadAiSettings();
        refreshSetupState();
    }

    @Override
    protected void onPause() {
        clearApiKeyInput();
        cancelConnectionTest(true);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelConnectionTest(false);
        openAiExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshSetupState();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // The input-method picker is a system window and does not consistently pause this
        // activity. Refresh once it closes so the selected state changes without a restart.
        if (hasFocus) {
            refreshSetupState();
        }
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_RECORD_AUDIO) {
            refreshSetupState();
            if (!hasMicrophonePermission()) {
                Toast.makeText(
                        this,
                        R.string.setup_microphone_permission_denied,
                        Toast.LENGTH_LONG)
                        .show();
            }
        }
    }

    private void refreshSetupState() {
        if (microphoneStatus == null || imeEnabledStatus == null || imeSelectedStatus == null) {
            return;
        }

        boolean microphoneGranted = hasMicrophonePermission();
        setStatus(
                microphoneStatus,
                R.string.setup_status_microphone,
                microphoneGranted,
                R.string.setup_status_permission_granted,
                R.string.setup_status_permission_needed);
        setStatus(
                imeEnabledStatus,
                R.string.setup_status_ime_enabled,
                isOwnInputMethodEnabled(),
                R.string.setup_status_enabled,
                R.string.setup_status_not_enabled);
        setStatus(
                imeSelectedStatus,
                R.string.setup_status_ime_selected,
                isOwnInputMethodSelected(),
                R.string.setup_status_selected,
                R.string.setup_status_not_selected);

        if (microphoneGranted) {
            microphonePermissionRequested = false;
            microphoneButton.setText(R.string.setup_microphone_permission_granted_button);
            microphoneButton.setEnabled(false);
        } else if (mustOpenAppSettingsForMicrophone()) {
            microphoneButton.setText(R.string.setup_open_app_settings_button);
            microphoneButton.setEnabled(true);
        } else {
            microphoneButton.setText(R.string.setup_grant_microphone_button);
            microphoneButton.setEnabled(true);
        }
        refreshApiKeyState();
    }

    private void loadAiSettings() {
        aiPolishEnabled.setChecked(preferences.getBoolean(
                KoekakiSettings.KEY_AI_POLISH_ENABLED,
                KoekakiSettings.DEFAULT_AI_POLISH_ENABLED));
        builtinTermsEnabled.setChecked(preferences.getBoolean(
                KoekakiSettings.KEY_USE_BUILTIN_TERMS,
                KoekakiSettings.DEFAULT_USE_BUILTIN_TERMS));
        modelInput.setText(preferences.getString(
                KoekakiSettings.KEY_OPENAI_MODEL,
                KoekakiSettings.DEFAULT_OPENAI_MODEL));
        dictionaryInput.setText(preferences.getString(
                KoekakiSettings.KEY_USER_DICTIONARY,
                ""));
        styleSampleInput.setText(preferences.getString(
                KoekakiSettings.KEY_STYLE_SAMPLE,
                ""));

        String selectedMode = KoekakiPrompts.findMode(preferences.getString(
                KoekakiSettings.KEY_ACTIVE_MODE_ID,
                KoekakiSettings.DEFAULT_MODE_ID)).getId();
        String[] modeIds = getResources().getStringArray(R.array.setup_polish_mode_ids);
        int selection = 0;
        for (int index = 0; index < modeIds.length; index++) {
            if (modeIds[index].equals(selectedMode)) {
                selection = index;
                break;
            }
        }
        polishMode.setSelection(selection);
    }

    private void pasteApiKeyFromClipboard() {
        CharSequence pasted;
        try {
            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
            ClipData data = clipboard == null ? null : clipboard.getPrimaryClip();
            pasted = data != null && data.getItemCount() > 0
                    ? data.getItemAt(0).coerceToText(this)
                    : null;
        } catch (RuntimeException exception) {
            pasted = null;
        }
        if (pasted == null || pasted.length() == 0) {
            Toast.makeText(this, R.string.setup_clipboard_unavailable, Toast.LENGTH_LONG).show();
            return;
        }
        apiKeyInput.setText(pasted);
        apiKeyInput.setSelection(apiKeyInput.length());
    }

    private void saveApiKey() {
        cancelConnectionTest(true);
        try {
            apiKeyStore.save(apiKeyInput.getText().toString());
            saveAiSettings(false);
            clearApiKeyInput();
            refreshApiKeyState();
            openAiTestStatus.setText(R.string.setup_test_openai_note);
            Toast.makeText(this, R.string.setup_api_key_saved_message, Toast.LENGTH_LONG).show();
        } catch (ApiKeyInputPolicy.ValidationException exception) {
            Toast.makeText(this, R.string.setup_api_key_invalid_message, Toast.LENGTH_LONG).show();
        } catch (SecureApiKeyStore.SecureStoreException exception) {
            clearApiKeyInput();
            refreshApiKeyState();
            Toast.makeText(this, R.string.setup_api_key_save_failed, Toast.LENGTH_LONG).show();
        }
    }

    private void confirmDeleteApiKey() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.setup_api_key_delete_title)
                .setMessage(R.string.setup_api_key_delete_description)
                .setNegativeButton(R.string.action_keep, null)
                .setPositiveButton(R.string.setup_api_key_delete_confirm,
                        (dialog, which) -> deleteApiKey())
                .show();
    }

    private void deleteApiKey() {
        cancelConnectionTest(true);
        clearApiKeyInput();
        try {
            apiKeyStore.delete();
            refreshApiKeyState();
            openAiTestStatus.setText(R.string.setup_test_openai_key_required);
            Toast.makeText(this, R.string.setup_api_key_deleted_message, Toast.LENGTH_LONG).show();
        } catch (SecureApiKeyStore.SecureStoreException exception) {
            refreshApiKeyState();
            Toast.makeText(this, R.string.setup_api_key_delete_failed, Toast.LENGTH_LONG).show();
        }
    }

    private void refreshApiKeyState() {
        if (apiKeyStatus == null || apiKeyStore == null) return;
        boolean saved = apiKeyStore.hasSavedKey();
        apiKeyStatus.setText(saved
                ? R.string.setup_api_key_saved
                : R.string.setup_api_key_not_saved);
        apiKeyStatus.setTextColor(getColor(saved
                ? R.color.koekaki_status_ready
                : R.color.koekaki_status_pending));
        if (deleteApiKeyButton != null) deleteApiKeyButton.setEnabled(saved);
    }

    private void saveAiSettings(boolean announce) {
        if (announce) cancelConnectionTest(true);
        String model = modelInput.getText().toString().trim();
        if (!isValidModelName(model)) {
            model = KoekakiSettings.DEFAULT_OPENAI_MODEL;
            modelInput.setText(model);
        }
        String[] modeIds = getResources().getStringArray(R.array.setup_polish_mode_ids);
        int position = polishMode.getSelectedItemPosition();
        String modeId = position >= 0 && position < modeIds.length
                ? modeIds[position]
                : KoekakiSettings.DEFAULT_MODE_ID;

        String dictionary = KoekakiSettings.limitText(
                dictionaryInput.getText().toString(),
                KoekakiSettings.MAX_DICTIONARY_TEXT_CHARS);
        String styleSample = KoekakiSettings.limitText(
                styleSampleInput.getText().toString(),
                KoekakiSettings.MAX_STYLE_SAMPLE_CHARS);
        dictionaryInput.setText(dictionary);
        styleSampleInput.setText(styleSample);

        preferences.edit()
                .putBoolean(KoekakiSettings.KEY_AI_POLISH_ENABLED, aiPolishEnabled.isChecked())
                .putString(KoekakiSettings.KEY_ACTIVE_MODE_ID,
                        KoekakiPrompts.findMode(modeId).getId())
                .putString(KoekakiSettings.KEY_OPENAI_MODEL, model)
                .putBoolean(KoekakiSettings.KEY_USE_BUILTIN_TERMS,
                        builtinTermsEnabled.isChecked())
                .putString(KoekakiSettings.KEY_USER_DICTIONARY, dictionary)
                .putString(KoekakiSettings.KEY_STYLE_SAMPLE, styleSample)
                .apply();
        if (announce) {
            Toast.makeText(this, R.string.setup_ai_settings_saved, Toast.LENGTH_LONG).show();
        }
    }

    private void testOpenAiConnection() {
        saveAiSettings(false);
        if (!apiKeyStore.hasSavedKey()) {
            openAiTestStatus.setText(R.string.setup_test_openai_key_required);
            return;
        }

        cancelConnectionTest(false);
        final OpenAiPolishClient client;
        try {
            client = new OpenAiPolishClient(modelInput.getText().toString().trim());
        } catch (IllegalArgumentException exception) {
            openAiTestStatus.setText(getString(
                    R.string.setup_test_openai_failed,
                    getString(R.string.setup_model_hint)));
            return;
        }

        long epoch = connectionTestGate.begin();
        activeTestClient = client;
        testOpenAiButton.setEnabled(false);
        openAiTestStatus.setText(R.string.setup_test_openai_running);
        activeTestFuture = openAiExecutor.submit(() -> {
            boolean succeeded = false;
            String failure = "";
            try {
                String key = apiKeyStore.load();
                if (key == null) {
                    failure = getString(R.string.setup_test_openai_key_required);
                } else {
                    client.testConnection(key);
                    succeeded = true;
                }
            } catch (SecureApiKeyStore.SecureStoreException
                     | OpenAiPolishClient.OpenAiException exception) {
                failure = exception.getMessage();
            } catch (RuntimeException exception) {
                failure = getString(R.string.setup_test_openai_key_required);
            }

            boolean completed = succeeded;
            String safeFailure = failure;
            runOnUiThread(() -> finishConnectionTest(epoch, client, completed, safeFailure));
        });
    }

    private void finishConnectionTest(
            long epoch,
            OpenAiPolishClient client,
            boolean succeeded,
            String failure) {
        if (!connectionTestGate.tryClaim(epoch) || activeTestClient != client) return;
        activeTestClient = null;
        activeTestFuture = null;
        testOpenAiButton.setEnabled(true);
        if (succeeded) {
            openAiTestStatus.setText(R.string.setup_test_openai_success);
        } else {
            String message = failure == null || failure.isEmpty()
                    ? getString(R.string.setup_test_openai_key_required)
                    : failure;
            openAiTestStatus.setText(getString(R.string.setup_test_openai_failed, message));
        }
        refreshApiKeyState();
    }

    private void cancelConnectionTest(boolean resetMessage) {
        connectionTestGate.cancel();
        OpenAiPolishClient client = activeTestClient;
        activeTestClient = null;
        if (client != null) client.cancel();
        Future<?> future = activeTestFuture;
        activeTestFuture = null;
        if (future != null) future.cancel(true);
        if (testOpenAiButton != null) testOpenAiButton.setEnabled(true);
        if (resetMessage && openAiTestStatus != null) {
            openAiTestStatus.setText(R.string.setup_test_openai_note);
        }
    }

    private void clearApiKeyInput() {
        if (apiKeyInput != null) apiKeyInput.getText().clear();
    }

    private static boolean isValidModelName(String value) {
        if (value == null || value.isEmpty() || value.length() > 100) return false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean allowed = (character >= 'a' && character <= 'z')
                    || (character >= 'A' && character <= 'Z')
                    || (character >= '0' && character <= '9')
                    || character == '-' || character == '_' || character == '.' || character == ':';
            if (!allowed) return false;
        }
        return true;
    }

    private void setStatus(
            TextView view,
            int labelResource,
            boolean ready,
            int readyResource,
            int pendingResource) {
        view.setText(getString(
                R.string.setup_status_format,
                getString(labelResource),
                getString(ready ? readyResource : pendingResource)));
        view.setTextColor(getColor(
                ready ? R.color.koekaki_status_ready : R.color.koekaki_status_pending));
    }

    private boolean hasMicrophonePermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void handleMicrophonePermission() {
        if (hasMicrophonePermission()) {
            refreshSetupState();
            return;
        }

        if (mustOpenAppSettingsForMicrophone()) {
            openApplicationSettings();
            return;
        }

        microphonePermissionRequested = true;
        requestPermissions(
                new String[]{Manifest.permission.RECORD_AUDIO},
                REQUEST_RECORD_AUDIO);
    }

    private boolean mustOpenAppSettingsForMicrophone() {
        return microphonePermissionRequested
                && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)
                && !hasMicrophonePermission();
    }

    private boolean isOwnInputMethodEnabled() {
        InputMethodManager manager = getSystemService(InputMethodManager.class);
        if (manager == null) {
            return false;
        }

        List<InputMethodInfo> enabledInputMethods = manager.getEnabledInputMethodList();
        for (InputMethodInfo inputMethod : enabledInputMethods) {
            if (getPackageName().equals(inputMethod.getServiceInfo().packageName)) {
                return true;
            }
        }
        return false;
    }

    private boolean isOwnInputMethodSelected() {
        String selectedInputMethod = Settings.Secure.getString(
                getContentResolver(),
                Settings.Secure.DEFAULT_INPUT_METHOD);
        if (selectedInputMethod == null || selectedInputMethod.isEmpty()) {
            return false;
        }

        ComponentName selectedComponent = ComponentName.unflattenFromString(selectedInputMethod);
        return selectedComponent != null
                && getPackageName().equals(selectedComponent.getPackageName());
    }

    private void openInputMethodSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS));
        } catch (ActivityNotFoundException exception) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private void showInputMethodPicker() {
        InputMethodManager manager = getSystemService(InputMethodManager.class);
        if (manager == null) {
            Toast.makeText(
                    this,
                    R.string.setup_input_method_picker_unavailable,
                    Toast.LENGTH_LONG)
                    .show();
            return;
        }
        manager.showInputMethodPicker();
    }

    private void openApplicationSettings() {
        Intent intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null));
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException exception) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }
}
