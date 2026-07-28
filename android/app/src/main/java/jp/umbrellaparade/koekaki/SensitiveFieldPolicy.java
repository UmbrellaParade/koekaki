package jp.umbrellaparade.koekaki;

import android.text.InputType;
import android.view.inputmethod.EditorInfo;

final class SensitiveFieldPolicy {
    private SensitiveFieldPolicy() {}

    static boolean isSupported(EditorInfo info) {
        return info != null && isSupportedInputType(info.inputType);
    }

    static boolean isSensitive(EditorInfo info) {
        if (info == null) return true;

        return isSensitiveInputType(info.inputType);
    }

    static boolean isSupportedInputType(int inputType) {
        return inputType != InputType.TYPE_NULL;
    }

    static boolean isSensitiveInputType(int inputType) {
        int inputClass = inputType & InputType.TYPE_MASK_CLASS;
        int variation = inputType & InputType.TYPE_MASK_VARIATION;
        if (inputClass == InputType.TYPE_CLASS_NUMBER) {
            return variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD;
        }
        if (inputClass != InputType.TYPE_CLASS_TEXT) return false;

        return variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD;
    }
}
