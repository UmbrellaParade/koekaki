package jp.umbrellaparade.koekaki;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;

/**
 * Launcher screen used to finish the one-time setup for the Koekaki input method.
 *
 * <p>This activity intentionally never reads or logs text entered in the test field. The field
 * exists only to give users a safe place to confirm that the IME can commit text before they open
 * Codex, Claude, LINE, or another app.</p>
 */
public final class SetupActivity extends Activity {
    public static final String PREFERENCES_NAME = "koekaki_settings";
    public static final String KEY_AUTO_RETURN_KEYBOARD = "auto_return_keyboard";

    private static final int REQUEST_RECORD_AUDIO = 1001;

    private TextView microphoneStatus;
    private TextView imeEnabledStatus;
    private TextView imeSelectedStatus;
    private Button microphoneButton;
    private SharedPreferences preferences;
    private boolean microphonePermissionRequested;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_setup);

        preferences = getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE);
        microphoneStatus = findViewById(R.id.status_microphone);
        imeEnabledStatus = findViewById(R.id.status_ime_enabled);
        imeSelectedStatus = findViewById(R.id.status_ime_selected);
        microphoneButton = findViewById(R.id.button_microphone_permission);

        microphoneButton.setOnClickListener(view -> handleMicrophonePermission());
        findViewById(R.id.button_open_ime_settings).setOnClickListener(
                view -> openInputMethodSettings());
        findViewById(R.id.button_choose_input_method).setOnClickListener(
                view -> showInputMethodPicker());

        CheckBox autoReturnKeyboard = findViewById(R.id.checkbox_auto_return_keyboard);
        autoReturnKeyboard.setChecked(
                preferences.getBoolean(KEY_AUTO_RETURN_KEYBOARD, false));
        autoReturnKeyboard.setOnCheckedChangeListener((buttonView, isChecked) ->
                preferences.edit().putBoolean(KEY_AUTO_RETURN_KEYBOARD, isChecked).apply());

        refreshSetupState();
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
